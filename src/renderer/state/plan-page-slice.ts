/**
 * The Plan view without a session (F2, #128): which plan the main area shows,
 * picked from the New Session picker, and the project it was picked in.
 *
 * It is a panel of the main area like the Session work page, and closes the
 * same way: whenever a session, the empty screen, the settings panel or the
 * Session work page takes the main area. `ui/plan-page/install-plan-page`
 * swaps the panel in and out and opens the plan view under its own owner.
 */
import type { RendererEvent } from './events';

export interface PlanPage {
  /** The project the plan was picked in: new issue sessions start there. */
  readonly projectPath: string;
  readonly repository: string;
  readonly number: number;
}

export interface PlanPageState {
  readonly open: PlanPage | null;
}

export const initialPlanPageState: PlanPageState = { open: null };

/** The owner the page opens its plan view under (see `plan-slice`). */
export function planPageOwner(page: Pick<PlanPage, 'repository' | 'number'>): string {
  return 'plan:' + page.repository + '#' + page.number;
}

export function planPageReducer(state: PlanPageState, event: RendererEvent): PlanPageState {
  switch (event.type) {
    case 'planPageOpened': {
      const was = state.open;
      const now = event.page;
      if (was && was.projectPath === now.projectPath && was.repository === now.repository && was.number === now.number) {
        return state;
      }
      return { open: { projectPath: now.projectPath, repository: now.repository, number: now.number } };
    }

    // Closed by its own Close or Esc, or by whatever else takes the main area.
    case 'planPageClosed':
    case 'activeSessionChanged':
    case 'sessionShown':
    case 'settingsOpened':
    case 'sessionWorkOpened':
      return state.open ? { open: null } : state;

    default:
      return state;
  }
}
