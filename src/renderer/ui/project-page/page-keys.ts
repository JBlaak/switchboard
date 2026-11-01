/**
 * What a key does on the project page (#174), from the rows on screen and
 * the cursor: ↑/↓ move through every row across sections, → expands a plan,
 * ← collapses it or goes from an issue up to its plan, ↵ opens what is under
 * the cursor (a PR on GitHub, #175), S starts a session on a startable issue
 * or (#175) in a worktree with none running, / filters. On a task (#251) the
 * Tasks page's keys: S starts a session on it, * stars it for today, D marks
 * it done, Z snoozes it to tomorrow, O opens it in Notion, ↵ its detail.
 *
 * Only bare keys reach this: `ProjectOverview` leaves modified keys, and keys
 * typed into an input, alone. Pure, so it is tested in node; the page carries
 * the answer out.
 */
import { steppedCursor } from '../../state/project-page-slice';
import { issueKeyString } from '../../../domain/plan/model';
import type { IssueKey } from '../../../domain/plan/model';
import { cursorId, type PageRow } from './page-rows';

export type PageKeyAction =
  | { readonly kind: 'cursor'; readonly target: string | null }
  | { readonly kind: 'expand'; readonly plan: string }
  | { readonly kind: 'collapse'; readonly plan: string }
  /** A plan, opened inside the page. */
  | { readonly kind: 'open-plan'; readonly plan: IssueKey }
  /** An issue, on GitHub. */
  | { readonly kind: 'open-issue'; readonly issue: IssueKey }
  | { readonly kind: 'open-session'; readonly sessionId: string }
  | { readonly kind: 'show-more-loose' }
  | { readonly kind: 'start'; readonly issue: IssueKey; readonly plan: IssueKey }
  /** A pull request, on GitHub. */
  | { readonly kind: 'open-pull-request'; readonly pullRequest: IssueKey }
  /** A session in one of the project's worktrees, by its path. */
  | { readonly kind: 'start-worktree'; readonly path: string }
  /** A task's row key (#251), as the Tasks page has them. */
  | { readonly kind: 'task'; readonly key: 'start' | 'star' | 'done' | 'snooze' | 'notion' | 'detail'; readonly taskId: string }
  | { readonly kind: 'filter' };

/** A task row's keys, as the Tasks page has them (`tasks-page/page-keys`). */
const TASK_KEYS: ReadonlyMap<string, Extract<PageKeyAction, { kind: 'task' }>['key']> = new Map([
  ['s', 'start'], ['S', 'start'], ['*', 'star'], ['d', 'done'], ['D', 'done'], ['z', 'snooze'], ['Z', 'snooze'],
  ['o', 'notion'], ['O', 'notion'], ['Enter', 'detail'],
] as const);

/** What `key` does with the cursor on `cursor` among `rows`; null for nothing. */
export function pageKeyAction(key: string, rows: readonly PageRow[], cursor: string | null): PageKeyAction | null {
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    return { kind: 'cursor', target: steppedCursor(rows.map(row => row.id), cursor, key === 'ArrowDown' ? 1 : -1) };
  }
  if (key === '/') return { kind: 'filter' };

  const row = rows.find(candidate => candidate.id === cursor);
  if (!row) return null;
  if (row.kind === 'task') {
    const taskKey = TASK_KEYS.get(key);
    return taskKey ? { kind: 'task', key: taskKey, taskId: row.taskId } : null;
  }
  switch (key) {
    case 'ArrowRight':
      return row.kind === 'plan' && !row.expanded ? { kind: 'expand', plan: issueKeyString(row.plan) } : null;
    case 'ArrowLeft':
      if (row.kind === 'plan') return row.expanded ? { kind: 'collapse', plan: issueKeyString(row.plan) } : null;
      if (row.kind === 'plan-issue') return { kind: 'cursor', target: cursorId.plan(row.plan) };
      return null;
    case 'Enter':
      switch (row.kind) {
        case 'plan': return { kind: 'open-plan', plan: row.plan };
        case 'plan-issue':
        case 'loose-issue': return { kind: 'open-issue', issue: row.issue };
        case 'more-loose': return { kind: 'show-more-loose' };
        case 'session': return { kind: 'open-session', sessionId: row.sessionId };
        case 'pull-request': return { kind: 'open-pull-request', pullRequest: row.pullRequest };
      }
      return null;
    case 's':
    case 'S':
      if (row.kind === 'plan-issue' && row.startable) return { kind: 'start', issue: row.issue, plan: row.plan };
      if (row.kind === 'worktree' && row.startable) return { kind: 'start-worktree', path: row.path };
      return null;
    default:
      return null;
  }
}
