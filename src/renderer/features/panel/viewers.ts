/**
 * Which of the main area's panels is showing.
 *
 * Terminals and the settings panel share one space, and only one may be
 * visible. Putting the terminal back hides settings first, which is what stops
 * it lingering behind the terminal.
 */
import { settingsViewer, terminalArea } from '../../lib/dom';
import { dispatch } from '../../state/app-store';

/** Put the terminal back. */
export function hideAllViewers(): void {
  settingsViewer.style.display = 'none';
  dispatch({ type: 'settingsClosed' });
  terminalArea.style.display = '';
}
