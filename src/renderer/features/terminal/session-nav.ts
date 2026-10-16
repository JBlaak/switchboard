// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow) ---
import { getState } from '../../state/app-store';
import { cursorTargets, rowOrder } from '../../state/list-cursor';
import { openSessions } from '../../state/session-store';
import { showSession } from '../terminal/terminal-manager';

/**
 * The open (not closed) sessions, in the order the sidebar lists their rows —
 * read from the list's layout, so rows folded away or behind "+ N older"
 * count too, in their place.
 */
function getOrderedOpenSessionIds(): string[] {
  const state = getState();
  return rowOrder(cursorTargets(state.sessionList, state.view.activePtyIds))
    .filter((id) => {
      const entry = openSessions.get(id);
      return !!entry && !entry.closed;
    });
}

function navigateSession(direction: -1 | 1): void {
  const ids = getOrderedOpenSessionIds();
  const current = getState().view.activeSessionId;
  const idx = current ? ids.indexOf(current) : -1;
  let next;
  if (idx === -1) {
    next = ids[0];
  } else {
    next = ids[(idx + direction + ids.length) % ids.length];
  }
  if (ids.length === 0 || !next) return;
  showSession(next);
}

// Returns true if the key combo is a session nav shortcut (used by xterm to block without acting)
export function isSessionNavKey(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.altKey) return false;
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) return true;
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return true;
  return false;
}

export function handleSessionNavKey(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.altKey) return false;

  // Cmd+Shift+[ or Cmd+Shift+] — prev/next session
  // On macOS, Shift changes e.key to { / }, so check code for reliable matching
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    if (e.type === 'keydown') navigateSession(e.code === 'BracketLeft' ? -1 : 1);
    return true;
  }

  // Cmd+Arrow — left/up and right/down cycle sessions
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    if (e.type === 'keydown') {
      const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
      navigateSession(dir);
    }
    return true;
  }

  return false;
}
