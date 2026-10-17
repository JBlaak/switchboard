/**
 * A plan, as the Plan tab sees it: one issue and its direct sub-issues (P1),
 * with the "Blocked by" links between them, their PRs and a summary of each
 * body. The main process fills these from one GraphQL request; the rules that
 * turn a plan into levels, states and warnings live in `layout.ts`.
 */

/** A GitHub issue. `repository` is `owner/repo`; two keys are the same issue when both parts agree. */
export interface IssueKey { repository: string; number: number }

/** A PR that closes an issue, by GitHub's closing references (P4). */
export interface PlanPullRequest {
  number: number;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  additions: number;
  deletions: number;
  headRef: string;
  baseRef: string;
}

export interface PlanIssue extends IssueKey {
  title: string;
  state: 'open' | 'closed';
  closedAs: 'completed' | 'not_planned' | null;
  updatedAt: string;
  /** Native "Blocked by" links, to plan issues or to `plan.outside`; anything else is ignored. */
  blockedBy: IssueKey[];
  pullRequests: PlanPullRequest[];
  summary: string;
  acceptance: { text: string; done: boolean }[];
}

export interface Plan extends IssueKey {
  title: string;
  /** The issue above this one, shown as a breadcrumb only (P1). */
  parent: (IssueKey & { title: string }) | null;
  issues: PlanIssue[];
  /** Blockers outside the plan, drawn as ghosts (P5). */
  outside: PlanIssue[];
}

export interface PlanSummary extends IssueKey {
  title: string;
  state: 'open' | 'closed';
  updatedAt: string;
  open: number;
  total: number;
  current: number | null;
  levels: number;
}

/** P7. */
export type NodeState = 'merged' | 'closed' | 'not-planned' | 'review' | 'draft' | 'ready' | 'locked';

export interface PlanLayout {
  /** Level 1 first; each row in drawing order (D1). */
  levels: IssueKey[][];
  /** 1-based; 0 for an issue that is not in the plan. */
  levelOf(issue: IssueKey): number;
  stateOf(issue: IssueKey): NodeState;
  /** The plan issues blocked by this one, in level and row order. */
  unlocks(issue: IssueKey): IssueKey[];
  /** The outside issues this one is blocked by (P5). */
  ghosts(issue: IssueKey): PlanIssue[];
  /** The 1-based level you are on (P3); null when the plan is cleared. */
  current: number | null;
  warnings: PlanWarning[];
}

/** D5. */
export type PlanWarning = { kind: 'no-links' } | { kind: 'closed-without-pr'; issue: IssueKey };

/** `owner/repo#n`: the string form of an issue key, for maps and IPC records. */
export function issueKeyString(issue: IssueKey): string {
  return issue.repository + '#' + issue.number;
}

export function sameIssue(a: IssueKey, b: IssueKey): boolean {
  return a.repository === b.repository && a.number === b.number;
}
