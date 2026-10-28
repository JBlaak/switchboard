/**
 * The project page's work outside React (#173, #174): its memory read back
 * from localStorage as the page opens on a project, and written as it
 * changes; and the project's overview (#172), asked for as the overview comes
 * on screen and every 60 s while it stays there.
 *
 * The panel is swapped in by the main area's route
 * (`ui/main-area/install-main-area`), and a plan inside the page is opened by
 * `ui/plan-page/install-plan-page`, which polls that plan itself. Nothing is
 * asked while the page is closed or shows one of its plans.
 *
 * The project's open tasks (#251) are read the same way, only while
 * BlaakTasks is on: as the overview comes on screen, every 60 s, and soon
 * after a session's task or the tasks' links change (a start, Change repo).
 */
import { dispatch, store } from '../../state/app-store';
import { projectRoute } from '../../state/main-area-slice';
import {
  memoryOf, overviewRequest, parseProjectPageMemories, projectPageMemory, remembered,
} from '../../state/project-page-slice';
import type { RendererState } from '../../state/root';
import { STORAGE_KEYS, readStored, writeStored } from '../../state/storage';
import { issueKeyString } from '../../../domain/plan/model';
import { loadProjectOverview, reloadProjectOverview } from './actions';
import { loadProjectTasks, tasksRequest } from './project-tasks';
import { recentPlansIn, withRecentPlan } from './recent-plans';

/** How often an open project page asks for its overview again (#167: 60 s, while it is open). */
export const OVERVIEW_POLL_MS = 60_000;

/** How long the tasks wait after a change before they are read again, so a burst of changes is read once. */
export const TASKS_SETTLE_MS = 250;

/** Start following the route. Answers a teardown. */
export function installProjectPage(): () => void {
  let polling: string | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let tasksFor: string | null = null;
  let tasksPoll: ReturnType<typeof setInterval> | null = null;
  let settling: ReturnType<typeof setTimeout> | null = null;

  const followTasks = (state: RendererState): void => {
    const projectPath = tasksRequest(state);
    if (projectPath === tasksFor) return;
    tasksFor = projectPath;
    if (tasksPoll) clearInterval(tasksPoll);
    tasksPoll = null;
    if (!projectPath) return;
    void loadProjectTasks(projectPath);
    tasksPoll = setInterval(() => void loadProjectTasks(projectPath), OVERVIEW_POLL_MS);
  };

  const tasksChangedSoon = (): void => {
    if (!tasksFor) return;
    if (settling) clearTimeout(settling);
    settling = setTimeout(() => {
      settling = null;
      if (tasksFor) void loadProjectTasks(tasksFor);
    }, TASKS_SETTLE_MS);
  };

  const follow = (state: RendererState): void => {
    const request = overviewRequest(state);
    const key = request ? [request.projectPath, request.closed, request.merged].join('\0') : null;
    if (key === polling) return;
    polling = key;
    if (poll) clearInterval(poll);
    poll = null;
    if (!request) return;
    const load = (): void => { void loadProjectOverview(request.projectPath, request.closed, request.merged); };
    load();
    poll = setInterval(load, OVERVIEW_POLL_MS);
  };

  const unsubscribe = store.subscribe((state, previous, event) => {
    followTasks(state);
    if (event.type === 'sessionTaskChanged' || event.type === 'tasksLinksLoaded') tasksChangedSoon();
    // A session started from the section: its worktree shows on the page.
    if (tasksFor && event.type === 'tasksStartAnswered' && event.outcome.kind === 'started') reloadProjectOverview();

    if (state.mainArea !== previous.mainArea) {
      const was = projectRoute(previous.mainArea);
      const now = projectRoute(state.mainArea);
      // Opened, or another project's page took its place: a fresh cursor and
      // filter, and this project's plans as they were left, with the plan
      // viewed last expanded too.
      if (now && now.projectPath !== was?.projectPath) {
        const stored = memoryOf(parseProjectPageMemories(readStored('localStorage', STORAGE_KEYS.projectPages)), now.projectPath);
        const memory = withRecentPlan(stored, recentPlansIn(now.projectPath));
        dispatch({ type: 'projectPageRestored', projectPath: now.projectPath, memory });
        return;
      }
      // Back from one of its plans: that plan, viewed last, is expanded.
      if (now && was && now.view.kind === 'overview' && was.view.kind === 'plan') {
        dispatch({ type: 'projectPlanExpanded', plan: issueKeyString(was.view) });
      }
    }

    follow(state);

    const page = state.projectPage;
    const before = previous.projectPage;
    if (page.projectPath === null || page.projectPath !== before.projectPath) return;
    if (page.expandedPlans === before.expandedPlans && page.showClosed === before.showClosed) return;
    const memories = parseProjectPageMemories(readStored('localStorage', STORAGE_KEYS.projectPages));
    const next = remembered(memories, page.projectPath, projectPageMemory(page));
    writeStored('localStorage', STORAGE_KEYS.projectPages, JSON.stringify(next));
  });

  return () => {
    if (poll) clearInterval(poll);
    if (tasksPoll) clearInterval(tasksPoll);
    if (settling) clearTimeout(settling);
    unsubscribe();
  };
}
