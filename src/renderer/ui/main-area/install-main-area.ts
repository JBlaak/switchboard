/**
 * The main area's panel swap, following the route (#168): the terminal area,
 * the settings panel, the Session work page, the project panel and the empty
 * screen are shown and hidden here, and only here, whenever the route in
 * `main-area-slice` moves. Each surface only says what it wants on screen.
 *
 * The swap is by style, never by unmounting: the xterm instances and their
 * PTYs carry on underneath, and a terminal needs its layout box back before it
 * can be refitted or take focus, which has to be true before the next line
 * runs rather than whenever React next commits.
 */
import { dispatch, getState, store } from '../../state/app-store';
import { openSessions } from '../../state/session-store';
import { clearNotifications } from '../../state/activity-store';
import {
  placeholder, projectPagePanel, sessionWorkPanel, settingsViewer, tasksPagePanel, terminalArea,
} from '../../lib/dom';
import { showEmptyScreen } from '../../features/patch/patch';
import { fitAndScroll } from '../../features/terminal/terminal-manager';
import type { MainAreaRoute } from '../../state/main-area-slice';
import type { RendererEvent } from '../../state/events';

/** Start following the route. Answers a teardown. */
export function installMainArea(): () => void {
  return store.subscribe((state, previous, event) => {
    const was = previous.mainArea.route;
    const now = state.mainArea.route;
    if (was === now) return;

    swapTo(now);
    // The settings form goes with its panel, whatever took the main area.
    if (now.kind !== 'settings' && getState().settings.panel) dispatch({ type: 'settingsClosed' });
    if (now.kind === 'session' && was.kind !== 'session') returnTo(now.sessionId, event);
  });
}

/** One panel on screen, the others hidden. */
function swapTo(route: MainAreaRoute): void {
  terminalArea.style.display = route.kind === 'session' ? '' : 'none';
  settingsViewer.style.display = route.kind === 'settings' ? 'flex' : 'none';
  sessionWorkPanel.style.display = route.kind === 'sessionWork' ? '' : 'none';
  projectPagePanel.style.display = route.kind === 'project' ? '' : 'none';
  tasksPagePanel.style.display = route.kind === 'tasks' ? '' : 'none';
  if (route.kind === 'empty') showEmptyScreen();
  else placeholder.style.display = 'none';
}

/**
 * Back to a session's terminal from a page that covered it: refitted, since
 * it could not follow a resize while hidden (which resizes the PTY only if
 * the size changed), focused, and read, since it was not being looked at.
 *
 * A session put on screen by `showSession` is fitted and focused there, once
 * React has rendered its container; and a session to return to whose terminal
 * was never opened (restored from storage, not reconnected) leaves nothing to
 * show, so the empty screen takes its place.
 */
function returnTo(sessionId: string, event: RendererEvent): void {
  if (event.type === 'sessionShown') return;
  const entry = openSessions.get(sessionId);
  if (!entry) {
    dispatch({ type: 'screenCleared' });
    return;
  }
  fitAndScroll(entry);
  entry.terminal.focus();
  clearNotifications(sessionId);
}
