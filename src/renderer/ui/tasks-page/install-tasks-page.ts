/**
 * The Tasks page's work outside React (#249): its effects handed in, and its
 * list watched while it is on screen. Main asks BlaakTasks for the page's
 * query as the watch starts and about once a minute after, pushing each
 * answer as `tasksChanged`; leaving the page, or a search with nothing typed,
 * stops it. A search being typed is watched once the typing pauses.
 *
 * What Switchboard links to the tasks (repos, session counts) is read as the
 * page opens, with each fresh list, and when a session's task changes.
 */
import { store } from '../../state/app-store';
import { TASKS_PAGE_WATCH, queryKey, tasksQuery } from '../../state/tasks-slice';
import { sessionMap, view } from '../../state/session-store';
import { openSession } from '../../features/sessions/session-actions';
import type { RendererState } from '../../state/root';
import { startTaskSession } from '../tasks/actions';
import { pulseSessionRow } from '../session-list/pulse';
import { loadTaskLinks, setTasksPageEffects } from './actions';

/** How long typing in the search pauses before it is asked. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Start following the route. Answers a teardown. */
export function installTasksPage(): () => void {
  setTasksPageEffects({
    startSession: startTaskSession,
    pulse: pulseSessionRow,
    openSession: (sessionId) => {
      const session = sessionMap.get(sessionId);
      if (session) void openSession(session);
    },
    projects: () => view.cachedAllProjects,
    now: () => new Date(),
  });

  let watching: string | null = null;
  let typing: ReturnType<typeof setTimeout> | null = null;

  const follow = (state: RendererState, previous: RendererState): void => {
    const open = state.mainArea.route.kind === 'tasks' && state.tasks.enabled;
    const query = open ? tasksQuery(state.tasks) : null;
    const key = query ? queryKey(query) : null;
    if (key === watching) return;
    if (typing) clearTimeout(typing);
    typing = null;
    const watch = (): void => {
      watching = key;
      if (query) void window.api.watchTasks(TASKS_PAGE_WATCH, query);
      else void window.api.unwatchTasks(TASKS_PAGE_WATCH);
    };
    const searching = query && state.tasks.tab === 'search' && state.tasks.search !== previous.tasks.search;
    if (searching) typing = setTimeout(watch, SEARCH_DEBOUNCE_MS);
    else watch();
  };

  return store.subscribe((state, previous, event) => {
    if (state.mainArea !== previous.mainArea || state.tasks !== previous.tasks) follow(state, previous);

    const open = state.mainArea.route.kind === 'tasks';
    const opened = open && previous.mainArea.route.kind !== 'tasks';
    const fresh = event.type === 'tasksChanged' && event.update.watchId === TASKS_PAGE_WATCH && event.update.state === 'ok';
    if (open && (opened || fresh || event.type === 'sessionTaskChanged')) void loadTaskLinks();
  });
}
