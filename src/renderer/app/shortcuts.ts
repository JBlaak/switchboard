/**
 * Keyboard shortcuts that work wherever focus happens to be.
 *
 * The terminal is the complication: xterm sees keys first, and handles the ones
 * that are also shell bindings itself. Where an action belongs to the app rather
 * than the shell, xterm's handler marks the event as dealt with and this
 * listener steps aside — which is what stops one keypress firing the same action
 * twice.
 */
import { focusSidebar, isSidebarFocusKey } from '../features/sessions/sidebar-keyboard';
import { handleSessionNavKey } from '../features/terminal/session-nav';

/** An event xterm's own handler has already acted on. */
type MarkedEvent = KeyboardEvent & { _handled?: boolean };

export function installShortcuts(): void {
  document.addEventListener('keydown', (e: MarkedEvent) => {
    if (e._handled) return;

    // Cmd+Shift+[ / ] and Cmd+Arrow move between sessions.
    handleSessionNavKey(e);

    // Cmd+L puts a cursor in the session list.
    if (isSidebarFocusKey(e)) {
      e.preventDefault();
      focusSidebar();
    }
  });
}

