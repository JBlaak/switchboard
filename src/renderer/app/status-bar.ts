/**
 * The status bar along the bottom.
 *
 * Two independent halves: a standing summary of what exists (sessions,
 * projects, how many are running) and a transient activity line the main
 * process writes into while it is indexing.
 */
import { view } from '../state/session-store';
import { el } from '../lib/dom';

/** How long a finished message stays before the line clears itself. */
const DONE_LINGER_MS = 3000;

const infoEl = el('status-bar-info');
const activityEl = el('status-bar-activity');

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/** The standing summary; recomputed after every project list. */
export function renderStatusSummary(): void {
  const sessions = view.cachedAllProjects.reduce((n, p) => n + p.sessions.length, 0);
  const projects = view.cachedAllProjects.length;
  const running = view.activePtyIds.size;

  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${sessions} sessions`);
  parts.push(`${projects} projects`);
  infoEl.textContent = parts.join(' · ');
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
