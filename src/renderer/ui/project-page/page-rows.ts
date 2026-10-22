/**
 * The project page's rows (#174): which of the overview's plans and issues
 * are on screen, given what is expanded, Show closed, Show N more and the
 * filter; and the rows the keyboard cursor walks, across every section.
 *
 * Every section hands the cursor its rows as `PageRow`s, in the order it
 * shows them, and the page walks them in reading order: Plans & issues,
 * Pull requests, then the right column's Sessions and Worktrees. Each row's
 * `id` is what `projectPage.cursor` holds, and what the row's element carries
 * as `data-cursor-id`. #175 adds its kinds (`pull-request`, `worktree`) here
 * and its sections' rows to `pageRows`.
 *
 * Pure, so it is tested in node.
 */
import { issueKeyString } from '../../../domain/plan/model';
import type { IssueKey } from '../../../domain/plan/model';
import type { LooseIssueRow, OverviewPlan, PlanIssueRow, ProjectOverviewGroups } from '../../../domain/plan/project-overview';
import type { ProjectIssue, ProjectPullRequest } from '../../../domain/project/overview';
import type { ProjectPageState } from '../../state/project-page-slice';

/** How many issues "Not in a plan" lists before "Show N more". */
export const LOOSE_SHOWN = 8;

/** One row the cursor can be on. */
export type PageRow =
  | { readonly kind: 'plan'; readonly id: string; readonly plan: IssueKey; readonly expanded: boolean }
  | { readonly kind: 'plan-issue'; readonly id: string; readonly plan: IssueKey; readonly issue: IssueKey; readonly startable: boolean }
  | { readonly kind: 'loose-issue'; readonly id: string; readonly issue: IssueKey }
  /** "Show N more" under the issues not in a plan. */
  | { readonly kind: 'more-loose'; readonly id: string }
  | { readonly kind: 'session'; readonly id: string; readonly sessionId: string };

/** The cursor ids, one way of spelling each kind of row. */
export const cursorId = {
  plan: (plan: IssueKey): string => 'plan:' + issueKeyString(plan),
  issue: (issue: IssueKey): string => 'issue:' + issueKeyString(issue),
  moreLoose: 'loose:more',
  session: (sessionId: string): string => 'session:' + sessionId,
};

/** True when every word of `filter` is in `text`, ignoring case; an empty filter keeps everything. */
export function matchesFilter(text: string, filter: string): boolean {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = text.toLowerCase();
  return words.every(word => haystack.includes(word));
}

type Plan = OverviewPlan<ProjectPullRequest>;
type IssueRow = PlanIssueRow<ProjectPullRequest>;
type LooseRow = LooseIssueRow<ProjectIssue, ProjectPullRequest>;

/** A plan as the section shows it: expanded or not, and the issues it shows when it is. */
export interface PlanOnScreen {
  readonly plan: Plan;
  readonly expanded: boolean;
  readonly issues: readonly IssueRow[];
}

/** What the Plans & issues section shows. */
export interface PlansView {
  readonly plans: readonly PlanOnScreen[];
  /** The issues not in a plan that are listed. */
  readonly loose: readonly LooseRow[];
  /** How many more there are behind "Show N more". */
  readonly hiddenLoose: number;
}

/** What decides the section's rows, from the project-page slice. */
export interface PlansViewOptions {
  readonly expandedPlans: readonly string[];
  readonly showClosed: boolean;
  readonly filter: string;
  readonly looseExpanded: boolean;
}

/**
 * The section's rows. Closed plans only with Show closed (they come last, as
 * the overview orders them). With a filter, a plan stays when it matches or
 * one of its issues does; one kept for its issues shows just those, expanded.
 * The issues not in a plan are filtered, then capped at `LOOSE_SHOWN` until
 * Show N more.
 */
export function plansView(groups: ProjectOverviewGroups<ProjectIssue, ProjectPullRequest>, options: PlansViewOptions): PlansView {
  const { expandedPlans, showClosed, filter, looseExpanded } = options;
  const plans: PlanOnScreen[] = [];
  for (const plan of groups.plans) {
    if (plan.state === 'closed' && !showClosed) continue;
    const expanded = expandedPlans.includes(issueKeyString(plan.plan));
    if (matchesFilter(issueText(plan.plan), filter)) {
      plans.push({ plan, expanded, issues: expanded ? plan.issues : [] });
      continue;
    }
    const matching = plan.issues.filter(row => matchesFilter(issueText(row.issue), filter));
    if (matching.length) plans.push({ plan, expanded: true, issues: matching });
  }

  const loose = groups.loose.filter(row => matchesFilter(issueText(row.issue) + ' ' + row.issue.labels.map(l => l.name).join(' '), filter));
  const shown = looseExpanded ? loose : loose.slice(0, LOOSE_SHOWN);
  return { plans, loose: shown, hiddenLoose: loose.length - shown.length };
}

/**
 * The section's rows for the page's state, when it has an answer to show for
 * `projectPath`: null while none has come, and when GitHub had nothing to say
 * (no repository, or it could not be asked; #175 shows why).
 */
export function plansViewOf(page: ProjectPageState, projectPath: string): PlansView | null {
  const github = page.overview?.projectPath === projectPath ? page.overview.github : null;
  return github?.ok ? plansView(github, page) : null;
}

/**
 * A plan's progress bar, one segment per issue in level order: the closed
 * ones, the next open one (in the accent, while the plan is open), and the rest.
 */
export function progressSegments(plan: Plan): ('closed' | 'next' | 'rest')[] {
  let next = plan.state === 'open';
  return plan.progress.segments.map(segment => {
    if (segment === 'merged' || segment === 'closed' || segment === 'not-planned') return 'closed';
    if (next) {
      next = false;
      return 'next';
    }
    return 'rest';
  });
}

/** How many sessions are running on a plan: its issues', or the plan's own. */
export function runningCount(plan: Plan): number {
  const issues = plan.issues.filter(row => row.status?.kind === 'running').length;
  return issues || (plan.running ? 1 : 0);
}

/** `#12 Title`: what a plan or an issue is found by. */
function issueText(issue: { number: number; title: string }): string {
  return '#' + issue.number + ' ' + issue.title;
}

/** The Plans & issues section's rows, in the order it shows them. */
export function planRows(view: PlansView): PageRow[] {
  const rows: PageRow[] = [];
  for (const { plan, expanded, issues } of view.plans) {
    const key: IssueKey = { repository: plan.plan.repository, number: plan.plan.number };
    rows.push({ kind: 'plan', id: cursorId.plan(key), plan: key, expanded });
    for (const row of issues) {
      const issue: IssueKey = { repository: row.issue.repository, number: row.issue.number };
      rows.push({ kind: 'plan-issue', id: cursorId.issue(issue), plan: key, issue, startable: row.startable });
    }
  }
  for (const row of view.loose) {
    const issue: IssueKey = { repository: row.issue.repository, number: row.issue.number };
    rows.push({ kind: 'loose-issue', id: cursorId.issue(issue), issue });
  }
  if (view.hiddenLoose > 0) rows.push({ kind: 'more-loose', id: cursorId.moreLoose });
  return rows;
}

/** The Sessions section's rows, from the sessions it lists. */
export function sessionRows(sessionIds: readonly string[]): PageRow[] {
  return sessionIds.map(sessionId => ({ kind: 'session', id: cursorId.session(sessionId), sessionId }));
}

/**
 * Every row on the page, in the order ↑/↓ walk them: the left column's
 * sections, then the right column's. #175 passes its Pull requests and
 * Worktrees rows in their places.
 */
export function pageRows(sections: {
  readonly plans: readonly PageRow[];
  readonly pullRequests?: readonly PageRow[];
  readonly sessions: readonly PageRow[];
  readonly worktrees?: readonly PageRow[];
}): PageRow[] {
  return [...sections.plans, ...(sections.pullRequests ?? []), ...sections.sessions, ...(sections.worktrees ?? [])];
}
