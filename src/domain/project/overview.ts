/**
 * What a project page (#167) reads about a repository: its issues, its pull
 * requests and its worktrees. The main process fills these from one GraphQL
 * request each and from `git worktree list`; grouping issues under their plans
 * is the plan domain's job, not this file's.
 */
import type { IssueKey } from '../plan/model';
import type { OverviewIssue, OverviewPullRequest, ProjectOverviewGroups } from '../plan/project-overview';

/** A label as GitHub shows it: its name and its colour, six hex digits without a `#`. */
export interface IssueLabel {
  name: string;
  color: string;
}

/** One of a repository's issues, with what places it in or under a plan. */
export interface RepositoryIssue extends IssueKey {
  title: string;
  state: 'open' | 'closed';
  labels: IssueLabel[];
  updatedAt: string;
  /** The issue this one is a sub-issue of, when it is one. */
  parent: IssueKey | null;
  /** How many sub-issues it has: one or more makes it a plan. */
  subIssues: number;
}

/**
 * A PR's checks taken together: `failing` as soon as one fails, `running`
 * while any has yet to finish, `passing` when all have, `none` when it has no
 * checks at all.
 */
export interface CheckRollup {
  state: 'passing' | 'running' | 'failing' | 'none';
  /** How many checks failed. */
  failing: number;
}

/** GitHub's review decision; null when the repository requires no review and nobody gave one. */
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;

/** One of a repository's pull requests, as the project page lists it. */
export interface RepositoryPullRequest {
  repository: string;
  number: number;
  title: string;
  state: 'open' | 'merged';
  draft: boolean;
  headRef: string;
  updatedAt: string;
  checks: CheckRollup;
  review: ReviewDecision;
  /** The issues it closes, by GitHub's closing references. */
  closes: IssueKey[];
}

/** One checkout of a repository: the main one, or a linked worktree. */
export interface WorktreeSummary {
  path: string;
  /** null on a detached HEAD. */
  branch: string | null;
  /** The main checkout, the one the others were added from. */
  main: boolean;
  /** Locked with `git worktree lock`: git will not prune or remove it. */
  locked: boolean;
  /** Uncommitted changes, untracked files included. */
  changedFiles: number;
  /** Commits on it that the default branch lacks. */
  ahead: number;
  /**
   * Its branch has nothing the default branch lacks. Never true on a detached
   * HEAD, nor for the default branch itself.
   */
  merged: boolean;
}

// ── The answer to a project page (#172) ──

/**
 * An open issue as the overview lists it: the read issue, with its parent and
 * sub-issues in the grouping rule's terms. A parent in another repository is
 * left out (null), so such an issue is loose in this one.
 */
export interface ProjectIssue extends Omit<RepositoryIssue, 'parent' | 'subIssues'>, OverviewIssue {}

/**
 * A pull request as the overview lists it: the read PR, with the issues it
 * closes in this repository by number. Closing references into other
 * repositories are left out.
 */
export interface ProjectPullRequest extends Omit<RepositoryPullRequest, 'closes'>, OverviewPullRequest {}

/**
 * Why the GitHub part has never been answered: `gh` is not installed, it is
 * not signed in to github.com, or GitHub could not be reached (or answered
 * with an error).
 */
export type GitHubUnavailableReason = 'no-gh' | 'signed-out' | 'unreachable';

/**
 * The GitHub part of a project page: its plans with their issues, its loose
 * issues and its pull requests, grouped by `groupOverview`. Open PRs come
 * first; merged ones follow when they were asked for.
 */
export type ProjectGitHubOverview =
  | ({
      ok: true;
      /** Epoch ms of the reads this answer is made of. */
      fetchedAt: number;
      /** The last refresh failed: this is the answer before it, as of `fetchedAt`. */
      stale: boolean;
    } & ProjectOverviewGroups<ProjectIssue, ProjectPullRequest>)
  | { ok: false; reason: GitHubUnavailableReason };

/** A checkout of the project, with the sessions running in it now. */
export interface WorktreeOverview extends WorktreeSummary {
  /** Ids of the Claude sessions running in it (or a directory under it). */
  running: string[];
}

/** Everything a project page shows that main knows, in one answer. */
export interface ProjectOverview {
  projectPath: string;
  /** An ssh project: only its running sessions are answered, nothing is read. */
  remote: boolean;
  /** `owner/repo` of its origin; null when it has no GitHub remote, or is remote. */
  repository: string | null;
  /** Null when there is no GitHub repository to ask about. */
  github: ProjectGitHubOverview | null;
  /** Its checkouts, main one included; none when it is not a git repository, or is remote. */
  worktrees: WorktreeOverview[];
  /** Ids of the Claude sessions running in the project, in any of its checkouts. */
  running: string[];
}

/** What the overview is asked to include beyond what is open. */
export interface ProjectOverviewOptions {
  /** Closed plans too. */
  closed?: boolean;
  /** Merged pull requests too. */
  merged?: boolean;
}
