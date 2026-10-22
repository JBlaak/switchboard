/**
 * What the Plan view without a session does (F2, #128): open a plan picked in
 * the New Session picker in the main area, as the route `project → plan`
 * (#168), inside its project's page (#173). Going back and closing are the
 * project page's (`ui/project-page/actions`).
 */
import { dispatch } from '../../state/app-store';
import { recordRecentPlan } from '../dialogs/recent-plans';

/** A plan, and the project it was picked in: new issue sessions start there. */
export interface PlanPage {
  readonly projectPath: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * Show `page`'s plan in the main area, and remember it as opened in its
 * project. Whatever had the main area gives way (the Session work page closes
 * on the same event); the session on screen stays the one to return to.
 */
export function openPlanPage(page: PlanPage): void {
  recordRecentPlan(page.projectPath, page);
  dispatch({
    type: 'projectOpened',
    projectPath: page.projectPath,
    view: { kind: 'plan', repository: page.repository, number: page.number },
  });
}
