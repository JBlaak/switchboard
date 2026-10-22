/**
 * The project page's back end (#172): everything main knows about a project,
 * in one answer. Its GitHub repository, its plans, loose issues and pull
 * requests grouped by `groupOverview` (#170), its worktrees, and which issues
 * and worktrees have a session running.
 *
 * Plans are read through PlanService, so they share its 30 s cache; the
 * issues and PRs are kept here for as long, so a second ask within 30 s does
 * not run `gh` at all. Which sessions run and own which issue is asked fresh
 * every time, because that is local and changes by the second.
 *
 * Stale over empty: when a refresh fails after a good answer, the last good
 * answer is served marked stale, with when it was fetched. When there has
 * never been one, the answer says why: no `gh`, not signed in, or GitHub
 * could not be reached.
 *
 * A project without a GitHub remote answers only its local parts. An ssh
 * project answers its running sessions only: no git and no `gh` reads.
 */
import { isRemoteProjectPath } from '../../domain/project/remote-target';
import { gitHubRepository } from '../../domain/project/repo-url';
import { groupOverview, type OverviewPlanSource } from '../../domain/plan/project-overview';
import type { Plan } from '../../domain/plan/model';
import type {
  GitHubUnavailableReason, ProjectGitHubOverview, ProjectIssue, ProjectOverview, ProjectOverviewOptions,
  ProjectPullRequest, RepositoryIssue, RepositoryPullRequest, WorktreeOverview, WorktreeSummary,
} from '../../domain/project/overview';
import type { Clock } from '../ports/clock';
import type { GitWorkspace } from '../ports/git-workspace';
import type { GitHubCli, ProjectReads } from '../ports/github-cli';
import type { GitRemotes } from '../ports/git-remotes';
import type { IssueSessionService } from './issue-session-service';
import { PLAN_CACHE_MS, type PlanService } from './plan-service';

/** A Claude session running now, and the directory it runs in. */
export interface RunningSession {
  sessionId: string;
  projectPath: string;
}

export interface ProjectOverviewServiceDeps {
  plans: Pick<PlanService, 'projectPlans' | 'plan'>;
  /** Which session owns which issue (S1). */
  owners: Pick<IssueSessionService, 'issueSessions'>;
  /** The Claude sessions running now; plain terminals are not sessions. */
  running(): RunningSession[];
  git: Pick<GitWorkspace, 'worktreeRoot' | 'worktrees'>;
  remotes: GitRemotes;
  github: Pick<GitHubCli, 'available' | ProjectReads>;
  clock: Clock;
}

/** What `gh` answered for a repository, before it is grouped. */
interface GitHubReads {
  fetchedAt: number;
  plans: OverviewPlanSource[];
  issues: ProjectIssue[];
  /** Open ones, and merged ones when asked for. */
  pullRequests: ProjectPullRequest[];
}

export class ProjectOverviewService {
  /** Reads by repository and options, while they are fresh; a failed read is dropped once it lands. */
  readonly #fresh = new Map<string, { at: number; reads: Promise<GitHubReads | null> }>();
  /** The last good reads by repository and options, for when a refresh fails. */
  readonly #last = new Map<string, GitHubReads>();

  constructor(private readonly deps: ProjectOverviewServiceDeps) {}

  /** The project page's answer for `projectPath`. Closed plans and merged PRs only when asked. */
  async overview(projectPath: string, options: ProjectOverviewOptions = {}): Promise<ProjectOverview> {
    const running = this.deps.running();

    if (isRemoteProjectPath(projectPath)) {
      return {
        projectPath, remote: true, repository: null, github: null, worktrees: [],
        running: running.filter((session) => session.projectPath === projectPath).map((session) => session.sessionId),
      };
    }

    const root = await this.deps.git.worktreeRoot(projectPath);
    const origin = root ? await this.deps.remotes.originUrl(root) : null;
    const repository = (origin && gitHubRepository(origin)) || null;

    const [checkouts, github] = await Promise.all([
      root ? this.deps.git.worktrees(root) : Promise.resolve<WorktreeSummary[]>([]),
      repository ? this.#github(projectPath, repository, running, options) : Promise.resolve(null),
    ]);

    const worktrees = sessionsByWorktree(checkouts, running);
    const inProject = (path: string) => isWithin(path, projectPath) || (root !== null && isWithin(path, root));
    const projectRunning = new Set([
      ...worktrees.flatMap((worktree) => worktree.running),
      ...running.filter((session) => inProject(session.projectPath)).map((session) => session.sessionId),
    ]);
    return { projectPath, remote: false, repository, github, worktrees, running: [...projectRunning] };
  }

  async #github(
    projectPath: string,
    repository: string,
    running: RunningSession[],
    options: ProjectOverviewOptions,
  ): Promise<ProjectGitHubOverview> {
    const closed = options.closed === true;
    const merged = options.merged === true;
    const key = `${repository}:${closed ? 'closed' : 'open'}:${merged ? 'merged' : 'open'}`;

    const fresh = await this.#reads(key, () => this.#read(projectPath, repository, closed, merged));
    if (fresh) this.#last.set(key, fresh);
    const reads = fresh ?? this.#last.get(key);
    if (!reads) return { ok: false, reason: await this.#unavailable() };

    const owners = await this.deps.owners.issueSessions(repository).catch(() => ({}));
    const sessions = { owners, running: new Set(running.map((session) => session.sessionId)) };
    const open = reads.pullRequests.filter((pr) => pr.state === 'open');
    const mergedOnes = reads.pullRequests.filter((pr) => pr.state === 'merged');
    const input = { repository, plans: reads.plans, issues: reads.issues, sessions };
    const groups = groupOverview({ ...input, pullRequests: open });
    // Merged PRs are listed with their issues and plan, but never stand for an open issue's PR.
    if (mergedOnes.length > 0) groups.pullRequests.push(...groupOverview({ ...input, pullRequests: mergedOnes }).pullRequests);
    return { ok: true, fetchedAt: reads.fetchedAt, stale: fresh === null, ...groups };
  }

  /** Everything `gh` is asked for one answer; null when any of it could not be read. */
  async #read(projectPath: string, repository: string, closed: boolean, merged: boolean): Promise<GitHubReads | null> {
    const { plans, github, clock } = this.deps;
    const fetchedAt = clock.now();
    const [summaries, issues, pullRequests] = await Promise.all([
      plans.projectPlans(projectPath, { closed }),
      github.issuesIn(repository, { closed: false }),
      github.pullRequestsIn(repository, { merged }),
    ]);
    if (!summaries || !issues || !pullRequests) return null;

    const read = await Promise.all(summaries.map((summary) => plans.plan(summary.repository, summary.number)));
    if (read.some((plan) => plan === null)) return null;
    const sources = summaries.map((summary, at): OverviewPlanSource => ({
      plan: read[at] as Plan, state: summary.state, updatedAt: summary.updatedAt,
    }));

    return {
      fetchedAt,
      plans: sources,
      issues: issues.map((issue) => projectIssue(issue, repository)),
      pullRequests: pullRequests.map((pr) => projectPullRequest(pr, repository)),
    };
  }

  /** Why `gh` could not answer: it is missing, signed out, or GitHub was not reached. */
  async #unavailable(): Promise<GitHubUnavailableReason> {
    const availability = await this.deps.github.available().catch(() => 'ok' as const);
    return availability === 'missing' ? 'no-gh' : availability === 'unauthenticated' ? 'signed-out' : 'unreachable';
  }

  /** The reads kept under `key` while they are fresh, or a new read. */
  #reads(key: string, read: () => Promise<GitHubReads | null>): Promise<GitHubReads | null> {
    const now = this.deps.clock.now();
    const hit = this.#fresh.get(key);
    if (hit && now - hit.at < PLAN_CACHE_MS) return hit.reads;

    const entry = { at: now, reads: read().catch(() => null) };
    this.#fresh.set(key, entry);
    void entry.reads.then((reads) => {
      if (reads === null && this.#fresh.get(key) === entry) this.#fresh.delete(key);
    });
    for (const [other, cached] of this.#fresh) {
      if (now - cached.at >= PLAN_CACHE_MS) this.#fresh.delete(other);
    }
    return entry.reads;
  }
}

function projectIssue(issue: RepositoryIssue, repository: string): ProjectIssue {
  const { parent, subIssues, ...rest } = issue;
  return {
    ...rest,
    parent: parent && parent.repository === repository ? parent.number : null,
    subIssueCount: subIssues,
  };
}

function projectPullRequest(pr: RepositoryPullRequest, repository: string): ProjectPullRequest {
  return { ...pr, closes: pr.closes.filter((issue) => issue.repository === repository).map((issue) => issue.number) };
}

/**
 * Each checkout with the sessions running in it. A session in a linked
 * worktree under the main checkout (`.claude/worktrees/…`) belongs to that
 * worktree, not to the main one: the deepest checkout that holds it wins.
 */
function sessionsByWorktree(checkouts: WorktreeSummary[], running: RunningSession[]): WorktreeOverview[] {
  const byPath = new Map<string, string[]>(checkouts.map((checkout) => [checkout.path, []]));
  for (const session of running) {
    const holder = checkouts
      .filter((checkout) => isWithin(session.projectPath, checkout.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (holder) byPath.get(holder.path)!.push(session.sessionId);
  }
  return checkouts.map((checkout) => ({ ...checkout, running: byPath.get(checkout.path)! }));
}

/** `path` is `dir` or a directory under it. */
function isWithin(path: string, dir: string): boolean {
  const base = dir.replace(/\/+$/, '');
  return path === base || path.startsWith(base + '/');
}
