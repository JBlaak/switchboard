/**
 * What a key does on the Tasks page (#249), from the rows on screen and the
 * cursor: ↑/↓ (or J/K) move the cursor, and on the row under it S starts a
 * session, * stars it for today (★), D marks it done, Z snoozes it to
 * tomorrow, O opens it in Notion and Enter opens its detail; / goes to the
 * search.
 *
 * Only bare keys reach this (and S or * with Shift, which is how they are
 * typed): `TasksPage` leaves modified keys, and keys typed into an input,
 * alone. Pure, so it is tested in node; the page carries the answer out.
 */
import { steppedCursor } from '../../state/project-page-slice';
import type { TaskRow } from '../../../domain/tasks/model';

export type TasksKeyAction =
  | { readonly kind: 'cursor'; readonly taskId: string | null }
  | { readonly kind: 'start' | 'star' | 'done' | 'snooze' | 'notion' | 'detail'; readonly task: TaskRow }
  | { readonly kind: 'search' };

/** What `key` does with the cursor on `cursor` among `rows`; null for nothing. */
export function tasksKeyAction(key: string, rows: readonly TaskRow[], cursor: string | null): TasksKeyAction | null {
  // A cursor on no row (yet, or any more) is on the first, as the page shows it.
  const task = rows.find(row => row.id === cursor) ?? rows[0];
  if (key === 'ArrowDown' || key === 'j' || key === 'ArrowUp' || key === 'k') {
    const step = key === 'ArrowDown' || key === 'j' ? 1 : -1;
    return { kind: 'cursor', taskId: steppedCursor(rows.map(row => row.id), task?.id ?? null, step) };
  }
  if (key === '/') return { kind: 'search' };
  if (!task) return null;
  switch (key) {
    case 's':
    case 'S': return { kind: 'start', task };
    case '*': return { kind: 'star', task };
    case 'd':
    case 'D': return { kind: 'done', task };
    case 'z':
    case 'Z': return { kind: 'snooze', task };
    case 'o':
    case 'O': return { kind: 'notion', task };
    case 'Enter': return { kind: 'detail', task };
    default: return null;
  }
}
