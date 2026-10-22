/**
 * Laying the session list out again: the one way any caller asks for it.
 *
 * Asked for, not derived. The list holds its order still between layouts (see
 * `session-list-slice`), and the projects it is laid out from are shared rows
 * mutated in place outside the store (`session-store`), so no state change on
 * its own says "the list changed". Whoever changed it — a filter, a fetch, a
 * stop, a row moving section — calls this.
 *
 * It imports only state and lib modules, so anything in the renderer can call
 * it without an import cycle.
 */
import { dispatch, getState } from '../../state/app-store';
import { tierOf } from '../../state/activity-store';
import { sessionKeyIn } from '../../state/keys-slice';
import { listItems } from '../../state/session-list-layout';
import { view } from '../../state/session-store';
import { isFilteringView } from '../../state/view-slice';
import { projectsToRender } from '../../state/search-narrowing';
import { localDateKey } from '../../lib/format';
import { highlightedSession } from '../../state/main-area-slice';
import type { Project } from '../../../domain/project/project';

export interface RelayoutOptions {
  /**
   * Let the open session move to its true position too.
   *
   * The default keeps it parked where the user last saw it, so the list cannot
   * slide out from under the cursor while it reorders. A user-initiated action
   * (the re-sort button, a filter change) passes true.
   */
  resort?: boolean;
}

/**
 * Lay the list out again from the cached projects and the live signals.
 *
 * The rows are copied into the event as they stand now; the slice orders and
 * folds them (`session-list-slice`), and the list renders what it decided.
 */
export function relayoutSessionList({ resort = false }: RelayoutOptions = {}): void {
  const state = getState();
  const now = Date.now();
  const { items, activeItemId } = listItems(projectsForLayout(), {
    filters: state.view,
    running: state.view.activePtyIds,
    // The session on screen, whose folded group opens to show its lit row.
    activeSessionId: highlightedSession(state.mainArea),
    tierOf,
    keyOf: (sessionId) => sessionKeyIn(getState().keys, sessionId),
    today: localDateKey(new Date(now)),
  });
  dispatch({
    type: 'sessionListBuilt',
    items,
    activeItemId,
    resort,
    filtering: isFilteringView(state.view),
    visibleSessionCount: state.view.visibleSessionCount,
    sessionMaxAgeDays: state.view.sessionMaxAgeDays,
    now,
  });
}

/** Which projects this layout covers: see `projectsToRender`. */
function projectsForLayout(): readonly Project[] {
  return projectsToRender(view.cachedProjects, view.cachedAllProjects, view);
}
