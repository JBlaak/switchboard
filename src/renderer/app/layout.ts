/**
 * Refitting the terminal when the window resizes.
 *
 * xterm measures its grid in pixels, so every change to the space it occupies
 * has to be followed by a refit. The sidebar's own collapse and resize moved
 * to React (`ui/toolbar`), which refits on release itself.
 */
import { openSessions, view } from '../state/session-store';
import { safeFit } from '../features/terminal/terminal-manager';

export function installLayout(): void {
  installWindowResize();
}

/** Only the visible terminal needs refitting. */
function installWindowResize(): void {
  window.addEventListener('resize', () => {
    const active = view.activeSessionId ? openSessions.get(view.activeSessionId) : undefined;
    if (active) safeFit(active);
  });
}
