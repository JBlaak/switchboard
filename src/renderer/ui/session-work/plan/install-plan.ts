/**
 * The plan view's work outside React (W4): putting the Plan tab's view on
 * screen while the Session work page shows that tab, asking main for its plans
 * when it opens (or another plan is picked), and asking again every minute
 * while it stays on screen. Nothing runs while no plan view is open.
 *
 * Fetching and polling follow whichever plan view is open, whoever opened it,
 * so #128's Plan view without a session gets them by opening its view.
 */
import { dispatch, store } from '../../../state/app-store';
import { planSourceKey } from '../../../state/plan-slice';
import { workTabOf } from '../../../state/session-work-slice';
import type { RendererState } from '../../../state/root';
import { loadPlanView } from './load';
import { installLevelsSeen } from './levels-seen';

/** How often an open plan view asks again (W4). */
export const PLAN_POLL_MS = 60_000;

/** The owner the Session work page's Plan tab opens its view under. */
export function sessionWorkOwner(sessionId: string): string {
  return 'session-work:' + sessionId;
}

/** Start following the plan view. Answers a teardown. */
export function installPlan(): () => void {
  const stopLevelsSeen = installLevelsSeen();
  let poll: ReturnType<typeof setInterval> | null = null;

  const follow = (state: RendererState, previous: RendererState): void => {
    // The Plan tab: open while the page shows it, closed otherwise.
    const page = state.sessionWork.page;
    const wanted = page && workTabOf(state.sessionWork, page.sessionId) === 'plan' ? sessionWorkOwner(page.sessionId) : null;
    const owner = state.plan.view?.owner ?? null;
    // Another home's view (#128) is left alone unless the tab wants the screen.
    if (owner !== wanted && (wanted !== null || owner?.startsWith('session-work:'))) {
      if (owner?.startsWith('session-work:')) dispatch({ type: 'planViewClosed', owner });
      if (wanted && page) dispatch({ type: 'planViewOpened', owner: wanted, source: { kind: 'session', sessionId: page.sessionId } });
      return;
    }

    const view = state.plan.view;
    const was = previous.plan.view;
    const key = view ? view.owner + '\0' + planSourceKey(view.source) : null;
    const wasKey = was ? was.owner + '\0' + planSourceKey(was.source) : null;
    if (key === wasKey) return;

    if (poll) clearInterval(poll);
    poll = null;
    if (!view) return;
    void loadPlanView(view);
    poll = setInterval(() => {
      const current = store.getState().plan.view;
      if (current) void loadPlanView(current);
    }, PLAN_POLL_MS);
  };

  const unsubscribe = store.subscribe(follow);

  return () => {
    if (poll) clearInterval(poll);
    unsubscribe();
    stopLevelsSeen();
  };
}
