/**
 * The sidebar's view state: which session is on screen, which are running,
 * the filters, the search and the list limits.
 *
 * The cached project lists and the last render order are deliberately not
 * here. The project lists hold the shared `SessionRow` objects that every
 * surface mutates in place (a rename, a star, a re-key), which no immutable
 * slice can model without first changing all of those writers; the render
 * order is the vanilla renderer's private memory between two of its own
 * renders. Both stay on the `view` adapter in `session-store`, and move when
 * the sidebar does.
 */
import type { RendererEvent } from './events';

export interface ViewState {
  readonly activeSessionId: string | null;
  /** Session ids with a live PTY, as of the last poll. */
  readonly activePtyIds: ReadonlySet<string>;

  // Sidebar filters
  readonly showArchived: boolean;
  readonly showStarredOnly: boolean;
  readonly showRunningOnly: boolean;
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

/** True when any filter or a search is narrowing the list. */
export function isFilteringView(view: ViewState): boolean {
  return view.showStarredOnly || view.showRunningOnly || view.showTodayOnly
    || view.showArchived || view.searchMatchIds !== null;
}
