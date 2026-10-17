/**
 * What the Plan view without a session does (F2, #128): open a plan picked in
 * the New Session picker in the main area, and close it again.
 */
import { dispatch } from '../../state/app-store';
import { closeSessionWork } from '../session-work/actions';
import { recordRecentPlan } from '../dialogs/recent-plans';
import type { PlanPage } from '../../state/plan-page-slice';

/** Show `page`'s plan in the main area, and remember it as opened in its project. */
export function openPlanPage(page: PlanPage): void {
  recordRecentPlan(page.projectPath, page);
  // One page in the main area at a time: the Session work page gives way.
  closeSessionWork();
  dispatch({ type: 'planPageOpened', page });
}

/** Close the view; what it covered comes back. */
export function closePlanPage(): void {
  dispatch({ type: 'planPageClosed' });
}
