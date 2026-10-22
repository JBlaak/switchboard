/**
 * What a project page (#167) reads about a repository: its issues, its pull
 * requests and its worktrees. The main process fills these from one GraphQL
 * request each and from `git worktree list`; grouping issues under their plans
 * is the plan domain's job, not this file's.
 */
import type { IssueKey } from '../plan/model';

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
