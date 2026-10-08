/**
 * Keyboard shortcuts that work wherever focus happens to be.
 *
 * The terminal is the complication: xterm sees keys first, and handles the ones
 * that are also shell bindings itself. Where an action belongs to the app rather
 * than the shell, xterm's handler marks the event as dealt with and this
 * listener steps aside — which is what stops one keypress firing the same action
 * twice.
 */
import {
  archiveActiveSession, focusSidebar, isArchiveSessionKey, isSessionPickerKey, isSidebarFocusKey,
} from '../features/sessions/sidebar-keyboard';
import { showProjectPickerDialog } from '../features/dialogs/project-picker-dialog';
import { handleSessionNavKey } from '../features/terminal/session-nav';
import {
  isBareQuickSessionKey, isQuickSessionKey, launchQuickSession,
} from '../features/sessions/quick-session';

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

    // Cmd+A opens the new-session picker; in a text field it is Select All.
    if (isSessionPickerKey(e)) {
      e.preventDefault();
      showProjectPickerDialog();
    }

    // Cmd+E archives the open session; in a text field it is left alone.
    if (isArchiveSessionKey(e)) {
      e.preventDefault();
      archiveActiveSession();
    }

    // Cmd+N, or N outside the terminal and text fields, starts a quick session.
    if (isQuickSessionKey(e) || isBareQuickSessionKey(e)) {
      e.preventDefault();
      void launchQuickSession();
    }
  });
}

