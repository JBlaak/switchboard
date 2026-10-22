/**
 * The words the plan view puts on things: each state's label, a level's
 * status, the warnings, a node's last line and the header's counts. Pure, so
 * they are tested in node next to the slice.
 */
import { levelBullets, type LevelBullet } from '../../../../domain/plan/level-progress';
import { sameIssue } from '../../../../domain/plan/model';
import type { IssueKey, NodeState, Plan, PlanIssue, PlanLayout, PlanSummary, PlanWarning } from '../../../../domain/plan/model';

/** P7, as the node and the detail say it. */
export const STATE_LABEL: Readonly<Record<NodeState, string>> = {
  merged: 'Merged',
  closed: 'Closed · no PR',
  'not-planned': 'Not planned',
  review: 'In review',
  draft: 'Draft PR',
  ready: 'Ready',
  locked: 'Locked',
};

/** What a level band says (D2). */
export interface LevelStatus {
  readonly kind: 'here' | 'cleared' | 'locked';
  readonly label: string;
  readonly closed: number;
  readonly total: number;
}

export function issueIn(plan: Plan, issue: IssueKey): PlanIssue | undefined {
  return plan.issues.find(other => sameIssue(other, issue));
}

export function levelStatus(plan: Plan, layout: PlanLayout, level: number): LevelStatus {
  const row = layout.levels[level - 1] ?? [];
  const closed = row.filter(issue => issueIn(plan, issue)?.state === 'closed').length;
  const total = row.length;
  if (level === layout.current) return { kind: 'here', label: 'You are here', closed, total };
  if (closed === total) {
    const early = layout.current !== null && level > layout.current;
    return { kind: 'cleared', label: early ? 'Cleared early' : 'Cleared', closed, total };
  }
  return { kind: 'locked', label: 'Locked', closed, total };
}

/** The header's "Level n of m", or "Plan cleared" (P3). */
export function hereLabel(layout: PlanLayout): string {
  if (!layout.levels.length) return 'No issues yet';
  return layout.current === null ? 'Plan cleared' : `Level ${layout.current} of ${layout.levels.length}`;
}

/** One bullet per level for the header's progress (D2). */
export function planLevelBullets(layout: PlanLayout): LevelBullet[] {
  return levelBullets(layout.levels.map(row => row.map(issue => layout.stateOf(issue))));
}

export function closedCount(plan: Plan): number {
  return plan.issues.filter(issue => issue.state === 'closed').length;
}

/** The PRs the plan's issues link, each counted once (one PR may close several, P4). */
export function linkedPrCount(plan: Plan): number {
  return new Set(plan.issues.flatMap(issue => issue.pullRequests.map(pr => pr.number))).size;
}

/** A node's last line: its PR, what it needs, or that it starts the plan. */
export function nodeMiniLine(plan: Plan, issue: PlanIssue): string {
  const pr = mainPullRequest(issue);
  if (pr) return `PR #${pr.number} · +${pr.additions} −${pr.deletions}`;
  if (issue.blockedBy.length) return 'needs ' + issue.blockedBy.map(blocker => shortRef(plan, blocker)).join(' ');
  return 'starts the plan';
}

/** The PR to open for an issue: an open one first, then a merged one, then any. */
export function mainPullRequest(issue: PlanIssue): PlanIssue['pullRequests'][number] | null {
  const prs = issue.pullRequests;
  return prs.find(pr => pr.state === 'open') ?? prs.find(pr => pr.state === 'merged') ?? prs[0] ?? null;
}

/** `#12`, or `owner/repo#12` for an issue in another repository. */
export function shortRef(plan: IssueKey, issue: IssueKey): string {
  return issue.repository === plan.repository ? '#' + issue.number : issue.repository + '#' + issue.number;
}

/** A title cut to fit a pill. */
export function shortTitle(title: string, max = 30): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 2).replace(/[\s,:]+\S*$/, '');
  return (cut || title.slice(0, max - 2)) + '…';
}

/** A warning above the diagram (D5): a bold lead and the rest. */
export function warningText(plan: Plan, warning: PlanWarning): { title: string; text: string } {
  if (warning.kind === 'no-links') {
    return {
      title: 'No dependency links.',
      text: `None of these ${plan.issues.length} issues has a native “Blocked by” link, so they all sit on Level 1.`,
    };
  }
  const ref = shortRef(plan, warning.issue);
  return { title: `${ref} closed without a PR.`, text: `No PR says “Closes ${ref}”.` };
}

/** The issue's GitHub page. */
export function issueUrl(issue: IssueKey): string {
  return `https://github.com/${issue.repository}/issues/${issue.number}`;
}

export function pullRequestUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`;
}

/** A plan in the list of others (W2, W3): `Level 1 of 3 · 0/5`. */
export function summaryLine(summary: PlanSummary): string {
  const level = summary.current === null ? 'Plan cleared' : `Level ${summary.current} of ${summary.levels}`;
  return `${level} · ${summary.total - summary.open}/${summary.total}`;
}

/** An open issue on the current level holds the plan there while a later level waits (P3). */
export function isHolding(plan: Plan, layout: PlanLayout, issue: PlanIssue): boolean {
  return issue.state === 'open' && layout.current !== null
    && layout.levelOf(issue) === layout.current && layout.levels.length > layout.current;
}
