/**
 * What a key does on the project page (#174), from the rows on screen and
 * the cursor: ↑/↓ move through every row across sections, → expands a plan,
 * ← collapses it or goes from an issue up to its plan, ↵ opens what is under
 * the cursor, S starts a session on a startable issue, / filters.
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
  | { readonly kind: 'filter' };

/** What `key` does with the cursor on `cursor` among `rows`; null for nothing. */
export function pageKeyAction(key: string, rows: readonly PageRow[], cursor: string | null): PageKeyAction | null {
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    return { kind: 'cursor', target: steppedCursor(rows.map(row => row.id), cursor, key === 'ArrowDown' ? 1 : -1) };
  }
  if (key === '/') return { kind: 'filter' };

  const row = rows.find(candidate => candidate.id === cursor);
  if (!row) return null;
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
      }
      return null;
    case 's':
    case 'S':
      return row.kind === 'plan-issue' && row.startable ? { kind: 'start', issue: row.issue, plan: row.plan } : null;
    default:
      return null;
  }
}
