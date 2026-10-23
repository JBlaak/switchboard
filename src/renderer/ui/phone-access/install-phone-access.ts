/**
 * Phone access's launch-time work (#194): read the snapshot and the
 * terminals' owners, read the snapshot again whenever the settings open, and
 * keep each terminal in step with whether the Mac has it.
 *
 * A terminal a phone takes lets go of the keyboard; one that comes back to
 * the Mac is refitted to its panel and tells main its size, since the PTY was
 * sized for the phone meanwhile and an unchanged grid would not say so by
 * itself.
 */
import { onEvent, store } from '../../state/app-store';
import { hasEntry } from '../../state/records';
import { reclaimTerminal, releaseTerminal } from '../../features/terminal/terminal-manager';
import { loadPhoneAccess, loadTerminalOwners } from './actions';

export function installPhoneAccess(): void {
  store.subscribe((state, previous, event) => {
    const now = state.phoneAccess.owners;
    const before = previous.phoneAccess.owners;
    // A re-key moves an owner to the new id; the terminal itself moved with it.
    if (now === before || event.type === 'sessionForked') return;
    for (const sessionId of Object.keys(now)) if (!hasEntry(before, sessionId)) releaseTerminal(sessionId);
    for (const sessionId of Object.keys(before)) if (!hasEntry(now, sessionId)) reclaimTerminal(sessionId);
  });
  // The snapshot can have moved on while nobody looked; a missed push would show here.
  onEvent('settingsOpened', () => void loadPhoneAccess());

  void loadPhoneAccess();
  void loadTerminalOwners();
}
