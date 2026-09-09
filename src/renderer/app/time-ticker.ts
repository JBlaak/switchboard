/**
 * Keeping the "5m ago" labels honest.
 *
 * Rewrites just the time span in each row rather than re-rendering: the list
 * re-renders often enough already, and doing it on a timer would fight the
 * user's scroll position for no visible gain.
 */
import { sessionMap } from '../state/session-store';
import { sessionTimeLabel } from '../features/sessions/sidebar-row';

/** Fine enough that "just now" becomes "1m ago" without a visible lag. */
const TICK_MS = 30000;

export function installTimeTicker(): void {
  setInterval(() => {
    for (const [sessionId, session] of sessionMap) {
      if (!session.modified) continue;
      const timeEl = document.getElementById('si-' + sessionId)
        ?.querySelector<HTMLElement>('.session-time');
      if (timeEl) timeEl.textContent = sessionTimeLabel(session);
    }
  }, TICK_MS);
}
