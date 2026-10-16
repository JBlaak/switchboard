/**
 * Put focus back in the terminal after a redraw — unless the user is typing,
 * or walking the list with the keyboard.
 *
 * The list redraws on every status change, and stealing focus mid-keystroke
 * from the search box or a rename input would make either unusable.
 */
import { isSidebarFocused } from '../../features/sessions/sidebar-keyboard';
import { getState } from '../../state/app-store';
import { openSessions } from '../../state/session-store';

export function restoreTerminalFocus(): void {
  if (isSidebarFocused()) return;
  const active = document.activeElement as HTMLElement | null;
  const typing = active && (
    active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
    || active.isContentEditable || active.closest('.modal-overlay'));
  if (typing) return;
  // The question panel takes the keyboard while it is up; asking is itself a
  // status change, so the redraw it causes must not hand keys to the terminal.
  if (active?.closest('section.qp')) return;

  const { activeSessionId } = getState().view;
  const open = activeSessionId ? openSessions.get(activeSessionId) : undefined;
  open?.terminal.focus();
}
