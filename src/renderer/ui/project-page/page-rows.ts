/**
 * The project page's rows (#174): which of the overview's plans and issues
 * are on screen, given what is expanded, Show closed, Show N more and the
 * filter; and the rows the keyboard cursor walks, across every section.
 *
 * Every section hands the cursor its rows as `PageRow`s, in the order it
 * shows them, and the page walks them in reading order: Plans & issues,
 * Pull requests, then the right column's Sessions and Worktrees. Each row's
 * `id` is what `projectPage.cursor` holds, and what the row's element carries
 * as `data-cursor-id`. The Pull requests and Worktrees sections (#175) add
 * theirs: a PR (↵ opens it on GitHub) and a worktree (S starts a session there).
 * The Tasks section (#251) adds a task, with the Tasks page's keys on it.
 *
 * Pure, so it is tested in node.
 */
import { issueKeyString } from '../../../domain/plan/model';
import type { IssueKey, NodeState } from '../../../domain/plan/model';
import { levelBullets, type LevelBullet } from '../../../domain/plan/level-progress';
import type {
  LooseIssueRow, OverviewPlan, OverviewPullRequestRow, PlanIssueRow, ProjectOverviewGroups,
} from '../../../domain/plan/project-overview';
import type {
  CheckRollup, ProjectIssue, ProjectOverview, ProjectPullRequest, WorktreeOverview,
} from '../../../domain/project/overview';
import type { ProjectPageState } from '../../state/project-page-slice';
import type { BlaakTasksResult, TaskDetail, TaskRow } from '../../../domain/tasks/model';

/** How many issues "Not in a plan" lists before "Show N more". */
export const LOOSE_SHOWN = 8;

/** One row the cursor can be on. */
export type PageRow =
  | { readonly kind: 'plan'; readonly id: string; readonly plan: IssueKey; readonly expanded: boolean }
  | { readonly kind: 'plan-issue'; readonly id: string; readonly plan: IssueKey; readonly issue: IssueKey; readonly startable: boolean }
  | { readonly kind: 'loose-issue'; readonly id: string; readonly issue: IssueKey }
  /** "Show N more" under the issues not in a plan. */
  | { readonly kind: 'more-loose'; readonly id: string }
  | { readonly kind: 'session'; readonly id: string; readonly sessionId: string }
  | { readonly kind: 'pull-request'; readonly id: string; readonly pullRequest: IssueKey }
  | { readonly kind: 'worktree'; readonly id: string; readonly path: string; readonly startable: boolean }
  | { readonly kind: 'task'; readonly id: string; readonly taskId: string };

/** The cursor ids, one way of spelling each kind of row. */
export const cursorId = {
  plan: (plan: IssueKey): string => 'plan:' + issueKeyString(plan),
  issue: (issue: IssueKey): string => 'issue:' + issueKeyString(issue),
  moreLoose: 'loose:more',
  session: (sessionId: string): string => 'session:' + sessionId,
  pullRequest: (pr: IssueKey): string => 'pr:' + issueKeyString(pr),
  worktree: (path: string): string => 'worktree:' + path,
  task: (taskId: string): string => 'task:' + taskId,
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
 * A plan's progress, one bullet per level; a plan nobody levelled yet is one
 * level of all its sub-issues.
 */
export function planBullets(plan: Plan): LevelBullet[] {
  if (!plan.levelled) return levelBullets([plan.progress.segments]);
  const levels: NodeState[][] = Array.from({ length: plan.progress.levels }, () => []);
  for (const row of plan.issues) levels[row.level - 1]?.push(row.segment);
  return levelBullets(levels);
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
 * Worktrees rows in their places, and #251 its Tasks rows: under Pull
 * requests, or at the top of the one column of a page without GitHub.
 */
export function pageRows(sections: {
  readonly plans: readonly PageRow[];
  readonly pullRequests?: readonly PageRow[];
  readonly tasks?: readonly PageRow[];
  readonly sessions: readonly PageRow[];
  readonly worktrees?: readonly PageRow[];
}): PageRow[] {
  return [
    ...sections.plans, ...(sections.pullRequests ?? []), ...(sections.tasks ?? []), ...sections.sessions,
    ...(sections.worktrees ?? []),
  ];
}

// ── Pull requests (#175) ──

type PullRequestRow = OverviewPullRequestRow<ProjectPullRequest>;

/** What decides the Pull requests section's rows, from the project-page slice. */
export interface PullRequestsViewOptions {
  readonly showMerged: boolean;
  readonly filter: string;
}

/**
 * The Pull requests section's rows: the open ones, then (Show merged) the
 * merged ones, as the overview orders them; narrowed by the filter, which
 * finds a PR by number, title or head branch.
 */
export function pullRequestsView(groups: ProjectOverviewGroups<ProjectIssue, ProjectPullRequest>, options: PullRequestsViewOptions): PullRequestRow[] {
  return groups.pullRequests.filter(({ pullRequest: pr }) =>
    (options.showMerged || pr.state !== 'merged') && matchesFilter(issueText(pr) + ' ' + pr.headRef, options.filter));
}

/** The section's rows for the page's state: null while there is no answer, and when GitHub had nothing to say. */
export function pullRequestsViewOf(page: ProjectPageState, projectPath: string): PullRequestRow[] | null {
  const github = page.overview?.projectPath === projectPath ? page.overview.github : null;
  return github?.ok ? pullRequestsView(github, page) : null;
}

/** The Pull requests section's cursor rows. */
export function pullRequestRows(rows: readonly PullRequestRow[]): PageRow[] {
  return rows.map(({ pullRequest: pr }) => {
    const key: IssueKey = { repository: pr.repository, number: pr.number };
    return { kind: 'pull-request', id: cursorId.pullRequest(key), pullRequest: key };
  });
}

/** A PR's checks pill: passing, running, or how many fail; nothing when it has no checks. */
export function checksPill(checks: CheckRollup): { readonly tone: 'passing' | 'running' | 'failing'; readonly text: string } | null {
  switch (checks.state) {
    case 'passing': return { tone: 'passing', text: '✓ passing' };
    case 'running': return { tone: 'running', text: '● running' };
    case 'failing': return { tone: 'failing', text: '✕ ' + Math.max(1, checks.failing) + ' failing' };
    case 'none': return null;
  }
}

/** Where a PR's review stands, in a few words: a draft or merged one says so instead. */
export function reviewText(pr: ProjectPullRequest): string {
  if (pr.state === 'merged') return 'merged';
  if (pr.draft) return 'draft';
  switch (pr.review) {
    case 'approved': return 'approved';
    case 'changes_requested': return 'changes requested';
    case 'review_required': return 'review requested';
    default: return 'no review yet';
  }
}

// ── Worktrees (#175) ──

/** A worktree as the section shows it. */
export interface WorktreeOnScreen {
  readonly worktree: WorktreeOverview;
  /** Its branch, or its folder on a detached HEAD. */
  readonly title: string;
  /** The line under it: changes, ahead count and PR, or that it is merged and safe to remove. */
  readonly meta: string;
  /** A session runs in it now. */
  readonly running: boolean;
  /** Start session is offered: nothing runs there, and it is not merged. */
  readonly startable: boolean;
  /** The PR whose head is its branch, open before merged. */
  readonly pullRequest: ProjectPullRequest | null;
}

/**
 * The Worktrees section's rows: the main checkout first, then the rest by
 * their last commit, newest first; narrowed by the filter (branch or folder).
 * A merged one says it is safe to remove; the page never removes one.
 */
export function worktreesView(overview: ProjectOverview, filter: string): WorktreeOnScreen[] {
  const pullRequests = overview.github?.ok ? overview.github.pullRequests.map(row => row.pullRequest) : [];
  const ordered = [...overview.worktrees].sort((a, b) =>
    Number(b.main) - Number(a.main)
    || (b.lastCommitAt ?? -Infinity) - (a.lastCommitAt ?? -Infinity)
    || a.path.localeCompare(b.path));
  return ordered
    .filter(worktree => matchesFilter((worktree.branch ?? '') + ' ' + folderOf(worktree.path), filter))
    .map(worktree => {
      const heads = worktree.branch ? pullRequests.filter(pr => pr.headRef === worktree.branch) : [];
      const pullRequest = heads.find(pr => pr.state === 'open') ?? heads[0] ?? null;
      const running = worktree.running.length > 0;
      return {
        worktree,
        title: worktree.branch ?? folderOf(worktree.path),
        meta: worktreeMeta(worktree, pullRequest),
        running,
        startable: !running && !worktree.merged,
        pullRequest,
      };
    });
}

function worktreeMeta(worktree: WorktreeOverview, pullRequest: ProjectPullRequest | null): string {
  if (worktree.merged) {
    const merged = pullRequest?.state === 'merged' ? 'merged in #' + pullRequest.number : 'merged';
    return merged + ' · safe to remove';
  }
  const parts: string[] = [];
  if (worktree.main) parts.push(folderOf(worktree.path));
  else if (!worktree.branch) parts.push('detached');
  parts.push(worktree.changedFiles ? worktree.changedFiles + ' changed' : 'clean');
  if (worktree.ahead) parts.push('↑' + worktree.ahead);
  if (pullRequest) parts.push('PR #' + pullRequest.number);
  return parts.join(' · ');
}

/** The last part of a path. */
function folderOf(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

/** The Worktrees section's cursor rows. */
export function worktreeRows(rows: readonly WorktreeOnScreen[]): PageRow[] {
  return rows.map(row => ({ kind: 'worktree', id: cursorId.worktree(row.worktree.path), path: row.worktree.path, startable: row.startable }));
}

// ── Tasks (#251) ──

/**
 * How many of the project's linked tasks, newest link first, are asked of
 * BlaakTasks on each refresh: one `get` each, so a repo with a long history
 * of finished tasks stays cheap.
 */
export const PROJECT_TASKS_ASKED = 20;

/** `YYYY-MM-DD` of `now`, in local time. */
export function localDay(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Not Done or Dropped, and not snoozed past `today` (Z takes it off the list until tomorrow). */
export function isOpenTask(task: TaskRow, today: string): boolean {
  if (task.status === 'Done' || task.status === 'Dropped') return false;
  return !task.snoozedUntil || task.snoozedUntil.slice(0, 10) <= today;
}

/** A task's detail as a row: the list's fields only. */
function rowOf(detail: TaskDetail): TaskRow {
  const { notes: _notes, url: _url, brief: _brief, progress: _progress, ...row } = detail;
  return row;
}

/**
 * The Tasks section's rows from what BlaakTasks answered for each linked task
 * (`ids` newest link first, `answers` in the same order): the open ones, in
 * link order. A task BlaakTasks did not answer for keeps the row it had in
 * `previous`, so an outage doesn't empty the section.
 */
export function projectTaskRows(
  ids: readonly string[], answers: readonly BlaakTasksResult<TaskDetail>[], previous: readonly TaskRow[], today: string,
): TaskRow[] {
  const rows: TaskRow[] = [];
  ids.forEach((id, i) => {
    const answer = answers[i];
    const row = answer?.kind === 'ok' ? rowOf(answer.value) : previous.find(candidate => candidate.id === id);
    if (row && isOpenTask(row, today)) rows.push(row);
  });
  return rows;
}

/**
 * The Tasks section's rows for the page's state, narrowed by the filter; null
 * while it has none to show for `projectPath` (BlaakTasks off, no answer yet,
 * or no open task linked to it), when the section is left out.
 */
export function tasksViewOf(page: ProjectPageState, projectPath: string): TaskRow[] | null {
  const tasks = page.tasks?.projectPath === projectPath ? page.tasks : null;
  if (!tasks || !tasks.rows.length) return null;
  return tasks.rows.filter(task =>
    matchesFilter([task.title, task.summary ?? '', task.bucket ?? '', task.client ?? ''].join(' '), page.filter));
}

/** The Tasks section's cursor rows. */
export function taskRows(rows: readonly TaskRow[]): PageRow[] {
  return rows.map(task => ({ kind: 'task', id: cursorId.task(task.id), taskId: task.id }));
}
