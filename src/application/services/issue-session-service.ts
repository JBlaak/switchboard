/**
 * Sessions and a plan's issues: which session owns an issue (S1), and the
 * worktree a new session on an issue starts in (A2, A3).
 *
 * Both take a repository or a project rather than a session, so they work
 * from the Plan view without a session (F2) as well as from a session's Plan
 * tab. The session itself is started by the renderer, which makes its row:
 * this only prepares the worktree and the prompt Claude starts with.
 */
import { isRemoteProjectPath } from '../../domain/project/remote-target';
import { gitHubRepository } from '../../domain/project/repo-url';
import {
  issueLabel, issueOwners, startBase,
  type IssueOwnerCandidate, type IssueWorktreeRequest, type IssueWorktreeResult,
} from '../../domain/plan/issue-session';
import { sameIssue, type IssueKey } from '../../domain/plan/model';
import { issueBranchName, issueSessionPrompt } from '../../domain/plan/start';
import type { SessionPullRequest } from '../../domain/session/session';
import type { Clock } from '../ports/clock';
import type { GitWorkspace, GitWorktrees } from '../ports/git-workspace';
import type { GitHubCli } from '../ports/github-cli';
import type { GitRemotes } from '../ports/git-remotes';
import type { Logger } from '../ports/logger';
import type { TranscriptStore } from '../ports/transcript-store';

/** How long a PR's closing references are trusted before `gh` is asked again. */
export const CLOSING_REFS_TTL_MS = 5 * 60_000;

/** Where an issue's worktree goes, under the repository's main checkout. */
const WORKTREES_DIR = '/.claude/worktrees/';

/** A session that could own an issue: every listed one, and every running one. */
export interface IssueSessionCandidate {
  sessionId: string;
  projectPath: string;
  /** Its transcript folder; null when it has none. */
  folder: string | null;
  /** Epoch ms of its last activity. */
  activeAt: number;
  pullRequests: readonly SessionPullRequest[];
}

export interface IssueSessionServiceDeps {
  sessions(): IssueSessionCandidate[];
  transcripts: Pick<TranscriptStore, 'locations'>;
  git: Pick<GitWorkspace, 'currentBranch' | 'defaultBranch' | 'branchExists' | 'commitSha'> & Omit<GitWorktrees, 'removeWorktree'>;
  remotes: GitRemotes;
  github: Pick<GitHubCli, 'available' | 'closingIssues'>;
  clock: Clock;
  log: Logger;
}

export class IssueSessionService {
  /** `owner/repo` by project path; only answers that found one are kept. */
  readonly #repositories = new Map<string, string>();
  /** A session's transcript branches, as of its last activity. */
  readonly #branches = new Map<string, { activeAt: number; branches: string[] }>();
  /** The issues each PR (`owner/repo#n`) closes, and when `gh` said so. */
  readonly #closes = new Map<string, { at: number; closes: IssueKey[] }>();

  constructor(private readonly deps: IssueSessionServiceDeps) {}

  // ── Ownership (S1) ──

  /** `owner/repo#n` → the id of the session that owns it, across the repository's sessions. */
  async issueSessions(repository: string): Promise<Record<string, string>> {
    const candidates: { session: IssueSessionCandidate; branches: string[] }[] = [];
    for (const session of this.deps.sessions()) {
      if (isRemoteProjectPath(session.projectPath)) continue;
      if ((await this.#repositoryOf(session.projectPath)) !== repository) continue;
      candidates.push({ session, branches: await this.#branchesOf(session) });
    }

    const closes = await this.#closingRefs(candidates.flatMap(({ session }) => session.pullRequests), repository);
    const owners: IssueOwnerCandidate[] = candidates.map(({ session, branches }) => ({
      sessionId: session.sessionId,
      activeAt: session.activeAt,
      branches,
      closes: session.pullRequests.flatMap((pr) => closes.get(prKey(pr, repository)) ?? []),
    }));
    return issueOwners(owners, repository);
  }

  /**
   * The branches its transcripts were written on; a session with none yet
   * (just started) is on the branch its directory has checked out.
   */
  async #branchesOf(session: IssueSessionCandidate): Promise<string[]> {
    const known = this.#branches.get(session.sessionId);
    if (known && known.activeAt === session.activeAt && known.branches.length > 0) return known.branches;
    const written = session.folder ? this.deps.transcripts.locations(session.folder, session.sessionId) : [];
    let branches = [...new Set(written.map((location) => location.branch).filter(Boolean))];
    if (branches.length === 0) {
      const current = await this.deps.git.currentBranch(session.projectPath);
      branches = current ? [current] : [];
    }
    this.#branches.set(session.sessionId, { activeAt: session.activeAt, branches });
    return branches;
  }

  /** What each of these PRs closes, asked of `gh` once per few minutes per PR. */
  async #closingRefs(pullRequests: readonly SessionPullRequest[], repository: string): Promise<Map<string, IssueKey[]>> {
    const now = this.deps.clock.now();
    const stale = new Map<string, Set<number>>();
    for (const pr of pullRequests) {
      const cached = this.#closes.get(prKey(pr, repository));
      if (cached && now - cached.at < CLOSING_REFS_TTL_MS) continue;
      const repo = pr.repository || repository;
      if (!stale.has(repo)) stale.set(repo, new Set());
      stale.get(repo)!.add(pr.number);
    }

    if (stale.size > 0 && (await this.deps.github.available()) === 'ok') {
      for (const [repo, numbers] of stale) {
        const answers = await this.deps.github.closingIssues(repo, [...numbers]);
        if (!answers) {
          this.deps.log.warn('[issue-sessions] could not read the closing references of', repo, [...numbers].join(', '));
          continue;
        }
        for (const number of numbers) {
          const answer = answers.find((candidate) => candidate.number === number);
          const closes = (answer?.closes ?? []).map((issue) => ({ repository: issue.repository || repo, number: issue.number }));
          this.#closes.set(repo + '#' + number, { at: now, closes });
        }
      }
    }

    const answer = new Map<string, IssueKey[]>();
    for (const pr of pullRequests) {
      const cached = this.#closes.get(prKey(pr, repository));
      if (cached) answer.set(prKey(pr, repository), cached.closes);
    }
    return answer;
  }

  /** `owner/repo` of the project's origin, or null when it is not on GitHub. */
  async #repositoryOf(projectPath: string): Promise<string | null> {
    const known = this.#repositories.get(projectPath);
    if (known) return known;
    let origin = await this.deps.remotes.originUrl(projectPath);
    // A worktree that has been removed still names its repository in its path.
    const at = projectPath.indexOf(WORKTREES_DIR);
    if (!origin && at > 0) origin = await this.deps.remotes.originUrl(projectPath.slice(0, at));
    const repository = (origin && gitHubRepository(origin)) || null;
    if (repository) this.#repositories.set(projectPath, repository);
    return repository;
  }

  // ── Starting a session on an issue (A2, A3) ──

  /**
   * Make the worktree a new session on `issue` starts in: a branch named
   * after it, under the repository's `.claude/worktrees/`, off the default
   * branch, or off its blocker's open PR when it is Locked (A3). Answers the
   * worktree and the prompt, or why there is none.
   */
  async prepareIssueWorktree({ projectPath, issue, plan }: IssueWorktreeRequest): Promise<IssueWorktreeResult> {
    const { git } = this.deps;
    if (isRemoteProjectPath(projectPath)) return fail('A session on an issue can only start in a local project');
    const root = await git.mainCheckout(projectPath);
    if (!root) return fail('Not a git repository: ' + projectPath);
    const origin = await this.deps.remotes.originUrl(root);
    const repository = (origin && gitHubRepository(origin)) || null;
    if (!repository) return fail('Not a GitHub repository: its origin is not on github.com');
    if (issue.repository !== repository) {
      return fail(`#${issue.number} is in ${issue.repository}, not in this project's ${repository}`);
    }
    const planIssue = plan.issues.find((candidate) => sameIssue(candidate, issue));
    if (!planIssue) return fail(`#${issue.number} is not part of plan #${plan.number}`);

    const branch = issueBranchName(planIssue);
    if (await git.branchExists(root, branch)) return fail(`Branch ${branch} already exists`);

    const warnings: string[] = [];
    const defaultBranch = await git.defaultBranch(root);
    let base: string | null = null;
    let stackedOn: number | undefined;

    const chosen = startBase(plan, issue);
    if (chosen.kind === 'stacked') {
      const head = chosen.pullRequest.headRef;
      const fetched = await git.fetchBranch(root, head);
      if (fetched.ok && (await git.commitSha(root, 'origin/' + head))) {
        base = 'origin/' + head;
        stackedOn = chosen.pullRequest.number;
      } else {
        warnings.push(`Could not fetch #${chosen.pullRequest.number}'s branch ${head}` +
          (fetched.ok ? '' : ` (${fetched.reason})`) + `; started from ${defaultBranch} instead.`);
      }
    } else if (chosen.openBlockers.length > 0) {
      const names = chosen.openBlockers.map((blocker) => issueLabel(blocker, repository)).join(', ');
      warnings.push(`No open PR to stack on: ${names} ${chosen.openBlockers.length === 1 ? 'has' : 'have'} none yet; started from ${defaultBranch}.`);
    }

    if (!base) {
      const fetched = await git.fetchBranch(root, defaultBranch);
      if (await git.commitSha(root, 'origin/' + defaultBranch)) base = 'origin/' + defaultBranch;
      else if (await git.commitSha(root, defaultBranch)) base = defaultBranch;
      else return fail(`Could not find the default branch ${defaultBranch}` + (fetched.ok ? '' : `: ${fetched.reason}`));
      if (!fetched.ok) warnings.push(`Could not fetch ${defaultBranch} (${fetched.reason}); started from the last one fetched.`);
    }

    const worktreePath = root.replace(/\/+$/, '') + WORKTREES_DIR + branch;
    const added = await git.addWorktree(root, worktreePath, branch, base);
    if (!added.ok) return fail('Could not create the worktree: ' + added.reason);

    return {
      ok: true,
      worktreePath,
      branch,
      prompt: issueSessionPrompt(issue, plan, stackedOn),
      ...(stackedOn !== undefined ? { stackedOn } : {}),
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    };
  }
}

function fail(reason: string): IssueWorktreeResult {
  return { ok: false, reason };
}

function prKey(pr: SessionPullRequest, repository: string): string {
  return (pr.repository || repository) + '#' + pr.number;
}
