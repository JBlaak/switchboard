// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow) ---
import { sidebarContent } from '../../lib/dom';
import { openSessions, view } from '../../state/session-store';
import { isMac, showSession } from '../terminal/terminal-manager';

// Returns ordered list of open (non-closed) session IDs matching sidebar order.
function getOrderedOpenSessionIds() {
  const items = sidebarContent.querySelectorAll<HTMLElement>('.session-item[data-session-id]');
  const ids: string[] = [];
  for (const item of items) {
    const sid = item.dataset.sessionId;
    if (!sid) continue;
    const entry = openSessions.get(sid);
    if (entry && !entry.closed) ids.push(sid);
  }
  return ids;
}

function navigateSession(direction: -1 | 1): void {
  const ids = getOrderedOpenSessionIds();
  const current = view.activeSessionId;
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
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) return true;
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return true;
  return false;
}

export function handleSessionNavKey(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;

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
