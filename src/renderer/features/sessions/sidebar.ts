/**
 * The single entry point for every session-list redraw.
 *
 * One function, so no caller has to know which projects to render or how a
 * search narrows them — and so the two cross-cutting refreshes (`refreshSidebar`
 * and `reloadProjects`) have exactly one implementation each to register.
 */
import { setProjectsReloader, setSidebarRefresher } from '../../app/refresh';
import { dispatch, getState } from '../../state/app-store';
import { tierOf } from '../../state/activity-store';
import { sessionKeyIn } from '../../state/keys-slice';
import { listItems } from '../../state/session-list-layout';
import { view } from '../../state/session-store';
import { isFilteringView } from '../../state/view-slice';
import { localDateKey } from '../../lib/format';
import { loadProjects } from './session-list';
import type { Project } from '../../../domain/project/project';
import type { SidebarRefreshOptions } from '../../app/refresh';

/** Wire the two refresh events to their implementations. Called once, at boot. */
export function installSidebar(): void {
  setSidebarRefresher(render);
  setProjectsReloader((options) => loadProjects(options));
}

/**
 * Lay the list out again from the cached projects and the live signals.
 *
 * The rows are copied into the event as they stand now; the slice orders and
 * folds them (`session-list-slice`), and the list renders what it decided.
 */
function render({ resort = false }: SidebarRefreshOptions = {}): void {
  const state = getState();
  const now = Date.now();
  const { items, activeItemId } = listItems(projectsToRender(), {
    filters: state.view,
    running: state.view.activePtyIds,
    activeSessionId: state.view.activeSessionId,
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

/**
 * Which projects this render covers.
 *
 * A search ignores the archive filter — a session you searched for should be
 * findable whether or not it is archived — so it always renders from the full
 * list, narrowed to the matches.
 */
function projectsToRender(): Project[] {
  const matchIds = view.searchMatchIds;
  const source = matchIds !== null || view.showArchived
    ? view.cachedAllProjects
    : view.cachedProjects;

  if (matchIds === null) return source;

  const matchedPaths = view.searchMatchProjectPaths;
  const narrowed: Project[] = [];
  for (const project of source) {
    const hasMatchingSessions = project.sessions.some(s => matchIds.has(s.sessionId));
    const projectMatched = matchedPaths?.has(project.projectPath) ?? false;
    if (!hasMatchingSessions && !projectMatched) continue;
    // A project whose name matches contributes all of its sessions — there is
    // no directory header left to stand in for the project itself.
    narrowed.push({
      ...project,
      sessions: hasMatchingSessions
        ? project.sessions.filter(s => matchIds.has(s.sessionId))
        : project.sessions,
    });
  }
  return narrowed;
}
