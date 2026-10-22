/**
 * The project page's work outside React (#173): its memory read back from
 * localStorage as the page opens on a project, and written as it changes.
 *
 * The panel is swapped in by the main area's route
 * (`ui/main-area/install-main-area`), and a plan inside the page is opened by
 * `ui/plan-page/install-plan-page`. Fetching the project overview (#172) and
 * polling it every 60 s while the page is open belongs here too, following
 * the same route, once there is an overview to ask for.
 */
import { dispatch, store } from '../../state/app-store';
import { projectRoute } from '../../state/main-area-slice';
import {
  memoryOf, parseProjectPageMemories, projectPageMemory, remembered,
} from '../../state/project-page-slice';
import { STORAGE_KEYS, readStored, writeStored } from '../../state/storage';

/** Start following the route. Answers a teardown. */
export function installProjectPage(): () => void {
  return store.subscribe((state, previous) => {
    if (state.mainArea !== previous.mainArea) {
      const was = projectRoute(previous.mainArea);
      const now = projectRoute(state.mainArea);
      // Opened, or another project's page took its place: a fresh cursor and
      // filter, and this project's plans as they were left.
      if (now && now.projectPath !== was?.projectPath) {
        const memory = memoryOf(parseProjectPageMemories(readStored('localStorage', STORAGE_KEYS.projectPages)), now.projectPath);
        dispatch({ type: 'projectPageRestored', projectPath: now.projectPath, memory });
        return;
      }
    }

    const page = state.projectPage;
    const before = previous.projectPage;
    if (page.projectPath === null || page.projectPath !== before.projectPath) return;
    if (page.expandedPlans === before.expandedPlans && page.showClosed === before.showClosed) return;
    const memories = parseProjectPageMemories(readStored('localStorage', STORAGE_KEYS.projectPages));
    const next = remembered(memories, page.projectPath, projectPageMemory(page));
    writeStored('localStorage', STORAGE_KEYS.projectPages, JSON.stringify(next));
  });
}
