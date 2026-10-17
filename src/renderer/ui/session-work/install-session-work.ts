/**
 * The Session work page's work outside React: swapping it in for the terminal
 * and back, telling main when it closes, the clock its "updated Xs ago" runs
 * on, and fetching the selected item's diff.
 *
 * It follows the store rather than the actions, because the page closes for
 * reasons of its own slice (another session on screen, the screen cleared,
 * the settings panel opening) as well as on Esc, Back and Cmd+G, and every one
 * of them has to give the terminal back the same way.
 *
 * The swap is by style, like the settings panel's (see `ui/settings/actions`):
 * the terminal area is hidden, never unmounted, so the xterm instances and
 * their PTYs carry on underneath, and it has its layout box again before the
 * terminal is refitted and focused.
 */
import { dispatch, store } from '../../state/app-store';
import { openSessions } from '../../state/session-store';
import { placeholder, sessionWorkPanel, settingsViewer, terminalArea } from '../../lib/dom';
import { showEmptyScreen } from '../../features/patch/patch';
import { fitAndScroll } from '../../features/terminal/terminal-manager';
import { diffToLoad } from '../../state/session-work-slice';
import { loadDiff } from './actions';
import type { RendererState } from '../../state/root';

/** How often "updated Xs ago" moves on while the page is open. */
const TICK_MS = 1000;

/** Start following the page. Answers a teardown. */
export function installSessionWork(): () => void {
  let tick: ReturnType<typeof setInterval> | null = null;

  const unsubscribe = store.subscribe((state, previous) => {
    // The selected item's diff, asked for once it is selected and again when
    // a snapshot changes it (D8: lazily, never the whole page's at once).
    const page = state.sessionWork.page;
    if (page && page !== previous.sessionWork.page) {
      const wanted = diffToLoad(page);
      if (wanted) void loadDiff(page.sessionId, wanted.itemId, wanted.key);
    }

    const was = previous.sessionWork.page?.sessionId ?? null;
    const now = state.sessionWork.page?.sessionId ?? null;
    if (was === now) return;

    if (was) window.api.closeSessionWork(was);
    if (now) {
      showPanel();
      tick ??= setInterval(() => dispatch({ type: 'sessionWorkTicked', at: Date.now() }), TICK_MS);
    } else {
      if (tick) clearInterval(tick);
      tick = null;
      hidePanel(state);
    }
  });

  return () => {
    if (tick) clearInterval(tick);
    unsubscribe();
  };
}

function showPanel(): void {
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  if (settingsViewer.style.display !== 'none') {
    settingsViewer.style.display = 'none';
    dispatch({ type: 'settingsClosed' });
  }
  sessionWorkPanel.style.display = '';
}

/**
 * Put back what the page covered: the session's terminal, focused, or the
 * empty screen when no session is on screen any more. When the settings panel
 * is what replaced the page, it already has the main area.
 */
function hidePanel(state: RendererState): void {
  sessionWorkPanel.style.display = 'none';
  if (settingsViewer.style.display !== 'none') return;

  const entry = state.view.activeSessionId ? openSessions.get(state.view.activeSessionId) : undefined;
  if (!entry) {
    showEmptyScreen();
    return;
  }
  terminalArea.style.display = '';
  // Hidden, the terminal could not follow a window resize; it fits now that
  // it has a box again (which resizes the PTY only if the size changed).
  fitAndScroll(entry);
  entry.terminal.focus();
}
