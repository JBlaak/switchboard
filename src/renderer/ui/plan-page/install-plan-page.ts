/**
 * The Plan view without a session's work outside React (F2): swapping its
 * panel in for whatever the main area showed and back, and opening the plan
 * view under its own owner while it is on screen. Fetching and polling follow
 * the open plan view (`session-work/plan/install-plan`), so they come with it.
 *
 * The swap is by style, like the Session work page's (see
 * `session-work/install-session-work`): the terminals stay mounted underneath,
 * and get their layout box back before one is refitted and focused.
 */
import { dispatch, store } from '../../state/app-store';
import { openSessions } from '../../state/session-store';
import { planPageOwner } from '../../state/plan-page-slice';
import { placeholder, planPagePanel, settingsViewer, terminalArea } from '../../lib/dom';
import { showEmptyScreen } from '../../features/patch/patch';
import { fitAndScroll } from '../../features/terminal/terminal-manager';
import type { RendererState } from '../../state/root';

/** Start following the page. Answers a teardown. */
export function installPlanPage(): () => void {
  return store.subscribe((state, previous) => {
    const was = previous.planPage.open;
    const now = state.planPage.open;
    if (was === now) return;

    if (was) dispatch({ type: 'planViewClosed', owner: planPageOwner(was) });
    if (now) {
      showPanel();
      dispatch({
        type: 'planViewOpened',
        owner: planPageOwner(now),
        source: { kind: 'plan', repository: now.repository, number: now.number },
      });
    } else {
      hidePanel(state);
    }
  });
}

function showPanel(): void {
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  if (settingsViewer.style.display !== 'none') {
    settingsViewer.style.display = 'none';
    dispatch({ type: 'settingsClosed' });
  }
  planPagePanel.style.display = '';
}

/**
 * Put back what the view covered: the session's terminal, focused, or the
 * empty screen. When the settings panel or the Session work page is what
 * replaced it, that already has the main area.
 */
function hidePanel(state: RendererState): void {
  planPagePanel.style.display = 'none';
  if (settingsViewer.style.display !== 'none' || state.sessionWork.page) return;

  const entry = state.view.activeSessionId ? openSessions.get(state.view.activeSessionId) : undefined;
  if (!entry) {
    showEmptyScreen();
    return;
  }
  terminalArea.style.display = '';
  fitAndScroll(entry);
  entry.terminal.focus();
}
