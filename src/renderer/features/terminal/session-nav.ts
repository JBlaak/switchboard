// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow) ---
import { getState } from '../../state/app-store';
import { cursorTargets, rowOrder, stepOpenSession } from '../../state/list-cursor';
import { openSessions } from '../../state/session-store';
import { sessionNavDirection } from '../../lib/shortcut-keys';
import { showSession } from '../terminal/terminal-manager';

export { isSessionNavKey } from '../../lib/shortcut-keys';

/**
 * Step through the open (not closed) sessions, in the order the sidebar lists
 * their rows — read from the list's layout, so rows folded away or behind
 * "+ N older" count too, in their place.
 */
function navigateSession(direction: -1 | 1): void {
  const state = getState();
  const next = stepOpenSession(
    rowOrder(cursorTargets(state.sessionList, state.view.activePtyIds)),
    (id) => {
      const entry = openSessions.get(id);
      return !!entry && !entry.closed;
    },
    state.view.activeSessionId,
    direction,
  );
  if (next) showSession(next);
}

export function handleSessionNavKey(e: KeyboardEvent): boolean {
  const direction = sessionNavDirection(e);
  if (direction === null) return false;
  e.preventDefault();
  if (e.type === 'keydown') navigateSession(direction);
  return true;
}
