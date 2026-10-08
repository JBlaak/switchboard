/**
 * The status line in the sidebar footer.
 *
 * Two independent halves: a standing summary of how many sessions are
 * running and a transient activity line the main process writes into while
 * it is indexing.
 */
import { view } from '../state/session-store';
import { el } from '../lib/dom';

/** How long a finished message stays before the line clears itself. */
const DONE_LINGER_MS = 3000;

const infoEl = el('sidebar-footer-info');
const activityEl = el('sidebar-footer-activity');

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/** The standing summary; recomputed after every project list. */
export function renderStatusSummary(): void {
  const running = view.activePtyIds.size;
  infoEl.textContent = running > 0 ? `${running} running` : '';
}

/**
 * A progress line from the main process.
 *
 * A 'done' message lingers so the user can read it; anything else is replaced
 * by whatever comes next, and an empty one clears immediately.
 */
export function setStatusActivity(text: string, type: string): void {
  if (clearTimer) clearTimeout(clearTimer);

  activityEl.textContent = text;
  activityEl.className = type === 'done' ? 'status-done' : '';

  if (text && type !== 'done') return;
  clearTimer = setTimeout(() => {
    activityEl.textContent = '';
    activityEl.className = '';
  }, type === 'done' ? DONE_LINGER_MS : 0);
}
