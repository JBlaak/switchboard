/**
 * The sidebar's view state: which session is on screen, which are running,
 * the filters, the search and the list limits.
 *
 * The cached project lists are deliberately not here. They hold the shared
 * `SessionRow` objects that every surface mutates in place (a rename, a star,
 * a re-key), which no immutable slice can model without first changing all of
 * those writers, so they stay on the `view` adapter in `session-store`. The
 * list copies what it shows out of them at each redraw, and keeps its last
 * order in its own slice (`session-list-slice`).
 */
import type { RendererEvent } from './events';
import type { SidebarFilter } from './toolbar-slice';

export interface ViewState {
  readonly activeSessionId: string | null;
  /** Session ids with a live PTY, as of the last poll. */
  readonly activePtyIds: ReadonlySet<string>;

  // Sidebar filters
  readonly showArchived: boolean;
  readonly showStarredOnly: boolean;
  readonly showRunningOnly: boolean;
  readonly showSnoozedOnly: boolean;
  readonly showTodayOnly: boolean;

  /** null = no search active; a Set = the matched session ids. */
  readonly searchMatchIds: ReadonlySet<string> | null;
  /** Project paths matched by name, so their rows survive the filter. */
  readonly searchMatchProjectPaths: ReadonlySet<string> | null;

  readonly visibleSessionCount: number;
  readonly sessionMaxAgeDays: number;
}

export function initialViewState(activeSessionId: string | null = null): ViewState {
  return {
    activeSessionId,
    activePtyIds: new Set<string>(),
    showArchived: false,
    showStarredOnly: false,
    showRunningOnly: false,
    showSnoozedOnly: false,
    showTodayOnly: false,
    searchMatchIds: null,
    searchMatchProjectPaths: null,
    visibleSessionCount: 25,
    sessionMaxAgeDays: 3,
  };
}

export function viewReducer(state: ViewState, event: RendererEvent): ViewState {
  switch (event.type) {
    case 'activeSessionChanged':
      return state.activeSessionId === event.sessionId
        ? state
        : { ...state, activeSessionId: event.sessionId };

    case 'ptyStopped': {
      if (!state.activePtyIds.has(event.sessionId)) return state;
      const activePtyIds = new Set(state.activePtyIds);
      activePtyIds.delete(event.sessionId);
      return { ...state, activePtyIds };
    }

    case 'filterToggled':
      return toggleFilter(state, event.filter);

    case 'searchMatched':
      return state.searchMatchIds === event.ids && state.searchMatchProjectPaths === event.projectPaths
        ? state
        : { ...state, searchMatchIds: event.ids, searchMatchProjectPaths: event.projectPaths };

    case 'viewPatched': {
      // Only a field that really changed makes a new state, so writing a value
      // back unchanged notifies nobody.
      let next: ViewState | null = null;
      for (const key of Object.keys(event.patch) as (keyof ViewState)[]) {
        const value = event.patch[key];
        if (Object.is(state[key], value)) continue;
        next ??= { ...state };
        (next as Record<keyof ViewState, unknown>)[key] = value;
      }
      return next ?? state;
    }

    default:
      return state;
  }
}

/**
 * A re-keyed session stays on screen, running and matched under its new id.
 *
 * The session on screen moves whether or not it has a terminal open: the row
 * the user selected is the same session, so the highlight follows it.
 */
export function rekeyView(state: ViewState, oldId: string, newId: string): ViewState {
  if (oldId === newId) return state;
  const activeSessionId = state.activeSessionId === oldId ? newId : state.activeSessionId;
  const activePtyIds = movedId(state.activePtyIds, oldId, newId);
  const searchMatchIds = state.searchMatchIds && movedId(state.searchMatchIds, oldId, newId);
  if (activeSessionId === state.activeSessionId && activePtyIds === state.activePtyIds
    && searchMatchIds === state.searchMatchIds) {
    return state;
  }
  return { ...state, activeSessionId, activePtyIds, searchMatchIds };
}

function movedId(ids: ReadonlySet<string>, oldId: string, newId: string): ReadonlySet<string> {
  if (!ids.has(oldId)) return ids;
  const next = new Set(ids);
  next.delete(oldId);
  next.add(newId);
  return next;
}

/** The toggles that replace one another, by the view field each sets. */
const EXCLUSIVE_FILTERS = {
  archived: 'showArchived',
  pinned: 'showStarredOnly',
  running: 'showRunningOnly',
  snoozed: 'showSnoozedOnly',
} as const;

/**
 * Flip one filter.
 *
 * Archived, pinned, running and snoozed are mutually exclusive rather than cumulative:
 * each answers a different question about the whole list, and combining them
 * mostly produces an empty one. Today narrows whichever of those is on, so it
 * stacks.
 */
function toggleFilter(state: ViewState, filter: SidebarFilter): ViewState {
  if (filter === 'today') return { ...state, showTodayOnly: !state.showTodayOnly };
  const field = EXCLUSIVE_FILTERS[filter];
  const next = { ...state, showArchived: false, showStarredOnly: false, showRunningOnly: false, showSnoozedOnly: false };
  next[field] = !state[field];
  return next;
}

/** True when any filter or a search is narrowing the list. */
export function isFilteringView(view: ViewState): boolean {
  return view.showStarredOnly || view.showRunningOnly || view.showSnoozedOnly || view.showTodayOnly
    || view.showArchived || view.searchMatchIds !== null;
}
