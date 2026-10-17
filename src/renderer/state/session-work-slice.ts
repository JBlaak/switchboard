/**
 * The Session work page: which session's page is open, the snapshot it shows,
 * which item is selected, and which sessions the page can open for at all.
 *
 * The page is transient (D4). It belongs to the session on screen, so anything
 * that puts another session on screen, clears the screen, or opens the
 * settings panel in its place closes it — and so does showing its own session
 * again, which is what a click on that session's row does. Nothing about a
 * closed page is kept: opening it again starts from a skeleton.
 *
 * `canOpen` is the one thing kept across pages: every row asks once whether
 * its meta line is a button, and the answer is not going to change while the
 * app runs — except for a session main did not know yet when it was asked (a
 * new one, before its process started), which is why a "no" is dropped when
 * that session comes on screen.
 */
import { movedEntry, withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';
import type { SessionWorkSnapshot } from '../../domain/session-work/model';

export interface SessionWorkPage {
  readonly sessionId: string;
  /** The header's `Work · <name>`, as of when the page opened (or the session was renamed). */
  readonly name: string;
  /** null until the first snapshot: the list shows a skeleton. */
  readonly snapshot: SessionWorkSnapshot | null;
  /** The item the detail shows (`SessionWorkItem.id`); null when nothing is selectable. */
  readonly selectedItemId: string | null;
  /** Whether the Done group is expanded. Collapsed each time the page opens. */
  readonly doneExpanded: boolean;
}

export interface SessionWorkState {
  readonly page: SessionWorkPage | null;
  /** sessionId → whether the page can open for it, once main has been asked. */
  readonly canOpen: IdRecord<boolean>;
  /** The page's clock, for "updated Xs ago": stamped when it opens and on each tick. */
  readonly now: number;
}

export const initialSessionWorkState: SessionWorkState = { page: null, canOpen: {}, now: 0 };

export function sessionWorkReducer(state: SessionWorkState, event: RendererEvent): SessionWorkState {
  switch (event.type) {
    case 'sessionWorkOpened': {
      if (state.page?.sessionId === event.sessionId) return state;
      return {
        ...state,
        now: event.at,
        page: { sessionId: event.sessionId, name: event.name, snapshot: null, selectedItemId: null, doneExpanded: false },
      };
    }

    case 'sessionWorkClosed':
      return state.page?.sessionId === event.sessionId ? { ...state, page: null } : state;

    case 'sessionWorkSnapshot': {
      const { page } = state;
      if (!page || page.sessionId !== event.snapshot.sessionId) return state;
      const selectedItemId = keptSelection(event.snapshot, page.selectedItemId);
      return { ...state, page: { ...page, snapshot: event.snapshot, selectedItemId } };
    }

    case 'sessionWorkItemSelected': {
      const { page } = state;
      if (!page?.snapshot || page.selectedItemId === event.itemId) return state;
      if (!selectableItems(page.snapshot).some(item => item.id === event.itemId)) return state;
      return { ...state, page: { ...page, selectedItemId: event.itemId } };
    }

    case 'sessionWorkDoneToggled':
      return state.page ? { ...state, page: { ...state.page, doneExpanded: !state.page.doneExpanded } } : state;

    case 'sessionWorkTicked':
      return state.page && state.now !== event.at ? { ...state, now: event.at } : state;

    case 'sessionWorkEligibility': {
      const canOpen = withEntry(state.canOpen, event.sessionId, event.canOpen);
      return canOpen === state.canOpen ? state : { ...state, canOpen };
    }

    // Another session on screen, or none: the page was this one's.
    case 'activeSessionChanged':
      return state.page && state.page.sessionId !== event.sessionId ? { ...state, page: null } : state;

    // A session put on screen — another one, or this one again from its row —
    // takes the terminal area back. A "no" for it may have been asked before
    // main knew the session; it is asked again.
    case 'sessionShown': {
      const canOpen = state.canOpen[event.sessionId] === false
        ? withoutEntry(state.canOpen, event.sessionId)
        : state.canOpen;
      if (!state.page && canOpen === state.canOpen) return state;
      return { ...state, page: null, canOpen };
    }

    // The settings panel takes the main area in the page's place.
    case 'settingsOpened':
      return state.page ? { ...state, page: null } : state;

    case 'headerRenamed':
      return state.page?.sessionId === event.sessionId && state.page.name !== event.name
        ? { ...state, page: { ...state.page, name: event.name } }
        : state;

    default:
      return state;
  }
}

/** A re-keyed session keeps its open page and what is known about it. */
export function rekeySessionWork(state: SessionWorkState, oldId: string, newId: string): SessionWorkState {
  if (oldId === newId) return state;
  const canOpen = movedEntry(state.canOpen, oldId, newId);
  const page = state.page?.sessionId === oldId ? { ...state.page, sessionId: newId } : state.page;
  return canOpen === state.canOpen && page === state.page ? state : { ...state, canOpen, page };
}

// ── What the page shows, derived from a snapshot ──

type Item = SessionWorkSnapshot['items'][number];

/** The list's three groups (D5, D10), each in the order the snapshot gave. */
export interface WorkSections {
  /** Open and draft PRs, branches without a PR, uncommitted changes. */
  readonly inProgress: readonly Item[];
  /** Issues nothing closes that are still open (or whose state `gh` could not say). */
  readonly issues: readonly Item[];
  /** Merged and closed PRs, then closed issues. */
  readonly done: readonly Item[];
}

/** A merged or closed PR, or a closed issue: finished, whoever finished it. */
export function isDoneItem(item: Item): boolean {
  if (item.kind === 'pr') return item.pr.state === 'merged' || item.pr.state === 'closed';
  if (item.kind === 'issue') return 'state' in item.issue && item.issue.state === 'closed';
  return false;
}

export function workSections(snapshot: SessionWorkSnapshot): WorkSections {
  const inProgress: Item[] = [];
  const issues: Item[] = [];
  const done: Item[] = [];
  const doneIssues: Item[] = [];
  for (const item of snapshot.items) {
    if (isDoneItem(item)) (item.kind === 'issue' ? doneIssues : done).push(item);
    else if (item.kind === 'issue') issues.push(item);
    else inProgress.push(item);
  }
  return { inProgress, issues, done: [...done, ...doneIssues] };
}

/**
 * The items that can be selected, in list order. Issues — open or done — are
 * links out rather than selectable, and Done only counts while it is expanded.
 */
export function selectableItems(snapshot: SessionWorkSnapshot, doneExpanded = true): Item[] {
  const { inProgress, done } = workSections(snapshot);
  return doneExpanded ? [...inProgress, ...done.filter(item => item.kind !== 'issue')] : [...inProgress];
}

/**
 * The selection a new snapshot leaves: the same item while it is still there,
 * otherwise the first one in progress (or the first done one when nothing is).
 */
function keptSelection(snapshot: SessionWorkSnapshot, current: string | null): string | null {
  const items = selectableItems(snapshot);
  if (current && items.some(item => item.id === current)) return current;
  return items[0]?.id ?? null;
}

/**
 * The item `j` (1) or `k` (-1) moves to from `current`, among the ones on
 * screen; null when there is nowhere to go. Stops at either end rather than
 * wrapping, like the list's own cursor.
 */
export function steppedItemId(page: SessionWorkPage, direction: 1 | -1): string | null {
  if (!page.snapshot) return null;
  const ids = selectableItems(page.snapshot, page.doneExpanded).map(item => item.id);
  if (!ids.length) return null;
  const at = page.selectedItemId ? ids.indexOf(page.selectedItemId) : -1;
  if (at === -1) return ids[0];
  const next = at + direction;
  return next >= 0 && next < ids.length ? ids[next] : null;
}

/** The selected item, or null. */
export function selectedItem(page: SessionWorkPage): Item | null {
  if (!page.snapshot || !page.selectedItemId) return null;
  return page.snapshot.items.find(item => item.id === page.selectedItemId) ?? null;
}
