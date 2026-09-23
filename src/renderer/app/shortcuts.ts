/**
 * Keyboard shortcuts that work wherever focus happens to be.
 *
 * The terminal is the complication: xterm sees keys first, and handles the ones
 * that are also shell bindings itself. Where an action belongs to the app rather
 * than the shell, xterm's handler marks the event as dealt with and this
 * listener steps aside — which is what stops one keypress firing the same action
 * twice.
 */
import { isMac } from '../features/terminal/terminal-manager';
import { handleSessionNavKey, toggleGridView } from '../features/terminal/grid-view';
import { el } from '../lib/dom';

/** An event xterm's own handler has already acted on. */
type MarkedEvent = KeyboardEvent & { _handled?: boolean };

const GRID_TOGGLE_ICON = '<svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';

export function installShortcuts(): void {
  installGridToggleButton();

  document.addEventListener('keydown', (e: MarkedEvent) => {
    if (e._handled) return;

    // Cmd/Ctrl+Shift+G toggles the grid.
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'g' && mod && e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleGridView();
      return;
    }

    // Cmd+Shift+[ / ] and Cmd+Arrow move between sessions.
    handleSessionNavKey(e);
  });
}

/**
 * The grid toggle, inserted next to the re-sort button.
 *
 * Built here rather than in index.html because it belongs to the shortcut it
 * shares an action with, and the sidebar's filter row is otherwise static
 * markup.
 */
function installGridToggleButton(): void {
  const resortBtn = el('resort-btn');
  const button = document.createElement('button');
  button.id = 'grid-toggle-btn';
  button.title = 'Session overview';
  button.innerHTML = GRID_TOGGLE_ICON;
  button.addEventListener('click', toggleGridView);
  resortBtn.parentElement?.insertBefore(button, resortBtn);
}
