/**
 * The single entry point for every session-list redraw.
 *
 * One function, so no caller has to know which projects to render or how a
 * search narrows them — and so the two cross-cutting refreshes (`refreshSidebar`
 * and `reloadProjects`) have exactly one implementation each to register.
 */
import { refreshSidebar, setProjectsReloader, setSidebarRefresher } from '../../app/refresh';
import { view } from '../../state/session-store';
import { loadProjects } from './session-list';
import { renderSessionList } from './sidebar-render';
import type { Project } from '../../../domain/project/project';
import type { SidebarRefreshOptions } from '../../app/refresh';

/** Wire the two refresh events to their implementations. Called once, at boot. */
export function installSidebar(): void {
  setSidebarRefresher(render);
  setProjectsReloader((options) => loadProjects(options));
}

function render({ resort = false }: SidebarRefreshOptions = {}): void {
  renderSessionList(projectsToRender(), resort);
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

export { refreshSidebar };
