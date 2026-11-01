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
import { issueBranchName, issueContinuePrompt, issueSessionPrompt } from '../../domain/plan/start';
import type { SessionPullRequest } from '../../domain/session/session';
import type { Clock } from '../ports/clock';
import type { GitWorkspace, GitWorktrees } from '../ports/git-workspace';
import type { GitHubCli } from '../ports/github-cli';
import type { GitRemotes } from '../ports/git-remotes';
import type { Logger } from '../ports/logger';
import type { TranscriptStore } from '../ports/transcript-store';
import { BranchWorktrees, WORKTREES_DIR, type ChosenBase } from './branch-worktrees';

/** How long a PR's closing references are trusted before `gh` is asked again. */
export const CLOSING_REFS_TTL_MS = 5 * 60_000;

/** A session that could own an issue: every listed one, and every running one. */
export interface IssueSessionCandidate {
  sessionId: string;
  projectPath: string;
  /** Its transcript folder; null when it has none. */
  folder: string | null;
  /** Epoch ms of its last activity. */
  activeAt: number;
  pullRequests: readonly SessionPullRequest[];
  /** Archived: it owns no issue, but may still be the session an existing branch was worked on in. */
  archived?: boolean;
}

export interface IssueSessionServiceDeps {
  sessions(): IssueSessionCandidate[];
  transcripts: Pick<TranscriptStore, 'locations'>;
  git: Pick<GitWorkspace, 'currentBranch' | 'defaultBranch' | 'branchExists' | 'commitSha' | 'worktrees'> & GitWorktrees;
  remotes: GitRemotes;
  github: Pick<GitHubCli, 'available' | 'closingIssues'>;
  clock: Clock;
  log: Logger;
}

export class IssueSessionService {
  /** `owner/repo` by project path; only answers that found one are kept. */
  readonly #repositories = new Map<string, string>();
  /** The worktree mechanics, and the branches each session worked on. */
  readonly #worktrees: BranchWorktrees<IssueSessionCandidate>;
  /** The issues each PR (`owner/repo#n`) closes, and when `gh` said so. */
  readonly #closes = new Map<string, { at: number; closes: IssueKey[] }>();

  constructor(private readonly deps: IssueSessionServiceDeps) {
    this.#worktrees = new BranchWorktrees(deps);
  }

  // ── Ownership (S1) ──

  /** `owner/repo#n` → the id of the session that owns it, across the repository's sessions. */
  async issueSessions(repository: string): Promise<Record<string, string>> {
    const candidates: { session: IssueSessionCandidate; branches: string[] }[] = [];
    for (const session of this.deps.sessions()) {
      if (session.archived || isRemoteProjectPath(session.projectPath)) continue;
      if ((await this.#repositoryOf(session.projectPath)) !== repository) continue;
      candidates.push({ session, branches: await this.#worktrees.branchesOf(session) });
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
   *
   * When the branch exists already, nothing is written unless the request
   * says what to do with it (`existing`); the refusal says what is there.
   */
  async prepareIssueWorktree({ projectPath, issue, plan, existing }: IssueWorktreeRequest): Promise<IssueWorktreeResult> {
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

    let stackedOn: number | undefined;
    const base = async (defaultBranch: string): Promise<ChosenBase> => {
      const chosen = startBase(plan, issue);
      if (chosen.kind === 'stacked') {
        const head = chosen.pullRequest.headRef;
        const fetched = await git.fetchBranch(root, head);
        if (fetched.ok && (await git.commitSha(root, 'origin/' + head))) {
          stackedOn = chosen.pullRequest.number;
          return { base: 'origin/' + head, warnings: [] };
        }
        return {
          base: null,
          warnings: [`Could not fetch #${chosen.pullRequest.number}'s branch ${head}` +
            (fetched.ok ? '' : ` (${fetched.reason})`) + `; started from ${defaultBranch} instead.`],
        };
      }
      if (chosen.openBlockers.length > 0) {
        const names = chosen.openBlockers.map((blocker) => issueLabel(blocker, repository)).join(', ');
        return {
          base: null,
          warnings: [`No open PR to stack on: ${names} ${chosen.openBlockers.length === 1 ? 'has' : 'have'} none yet; started from ${defaultBranch}.`],
        };
      }
      return { base: null, warnings: [] };
    };

    const made = await this.#worktrees.prepare({ root, branch: issueBranchName(planIssue), existing, base });
    if (!made.ok) return made;
    const { worktreePath, branch } = made;
    if (made.reused) return { ok: true, worktreePath, branch, prompt: issueContinuePrompt(issue, plan) };
    return {
      ok: true,
      worktreePath,
      branch,
      prompt: issueSessionPrompt(issue, plan, stackedOn),
      ...(stackedOn !== undefined ? { stackedOn } : {}),
      ...(made.warnings.length ? { warning: made.warnings.join(' ') } : {}),
    };
  }
}

function fail(reason: string): IssueWorktreeResult {
  return { ok: false, reason };
}

function prKey(pr: SessionPullRequest, repository: string): string {
  return (pr.repository || repository) + '#' + pr.number;
}
