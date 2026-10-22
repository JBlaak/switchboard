/**
 * The Plan view without a session's work outside React (F2): opening the plan
 * view under its own owner while a project's plan has the main area, and
 * closing it after. Fetching and polling follow the open plan view
 * (`session-work/plan/install-plan`), so they come with it. The panel itself
 * is swapped in by the main area's route (`ui/main-area/install-main-area`).
 */
import { dispatch, store } from '../../state/app-store';
import { projectPlan, projectPlanOwner } from '../../state/main-area-slice';

/** Start following the route's plan. Answers a teardown. */
export function installPlanPage(): () => void {
  return store.subscribe((state, previous) => {
    if (state.mainArea === previous.mainArea) return;
    const was = projectPlan(previous.mainArea);
    const now = projectPlan(state.mainArea);
    if (was && now && projectPlanOwner(was) === projectPlanOwner(now)) return;

    if (was) dispatch({ type: 'planViewClosed', owner: projectPlanOwner(was) });
    if (now) {
      dispatch({
        type: 'planViewOpened',
        owner: projectPlanOwner(now),
        source: { kind: 'plan', repository: now.repository, number: now.number },
      });
    }
  });
}
