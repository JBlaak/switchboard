/**
 * Finding out which sessions are still running.
 *
 * Polled rather than pushed, because a session can start or die outside this
 * window — the scheduler spawns them, another window may stop them, and a
 * process can be killed without an exit event arriving. The cadence adapts:
 * fast while anything is running, slow when nothing is.
 *
 * Every renderer path that starts a session calls `pollActiveSessions`
 * explicitly, which re-arms the fast cadence immediately; the idle floor is
 * only there to catch what nothing told us about.
 */
import { clearActivity, notifyActivityChanged, sessionBusyState } from '../../state/activity-store';
import { view } from '../../state/session-store';
import { gridCards } from '../terminal/grid-view';
import { updateTerminalHeader } from './terminal-header';

const POLL_FAST_MS = 3000;
const POLL_IDLE_MS = 30000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export async function pollActiveSessions(): Promise<void> {
  try {
    view.activePtyIds = new Set(await window.api.getActiveSessions());
    updateRunningIndicators();
    // The live set belongs to the session store, so the activity store cannot
    // see it change; null tells its listeners to recompute everything. After
    // the repaint, so the dead rows' activity has already been cleared.
    notifyActivityChanged(null);
    updateTerminalHeader();
  } catch {
    // A failed poll is not worth reporting; the next one is 3 seconds away.
  }
  schedulePoll();
}

export function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = view.activePtyIds.size > 0 ? POLL_FAST_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(() => void pollActiveSessions(), delay);
}

/**
 * Repaint every "is it running" indicator from the poll's answer.
 *
 * Done by touching classes rather than re-rendering: this runs every three
 * seconds, and a full render would fight the user's scroll position and any
 * rename input they have open.
 */
export function updateRunningIndicators(): void {
  document.querySelectorAll<HTMLElement>('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    if (!sessionId) return;

    const running = view.activePtyIds.has(sessionId);
    item.classList.toggle('has-running-pty', running);
    // Nothing is running under it, so it cannot be busy, ready or waiting.
    if (!running) clearActivity(sessionId);
    item.querySelector<HTMLElement>('.session-status-dot')?.classList.toggle('running', running);
  });

  document.querySelectorAll<HTMLElement>('.slug-group').forEach(group => {
    const hasRunning = group.querySelector('.session-item.has-running-pty') !== null;
    group.querySelector<HTMLElement>('.slug-group-dot')?.classList.toggle('running', hasRunning);
  });

  for (const [sessionId, card] of gridCards) {
    const running = view.activePtyIds.has(sessionId);
    const busy = sessionBusyState.get(sessionId) === true;
    const dot = card.querySelector<HTMLElement>('.grid-card-dot');
    if (dot) dot.className = 'grid-card-dot ' + (busy ? 'busy' : running ? 'running' : 'stopped');
    const footer = card.querySelector<HTMLElement>('.grid-card-footer');
    if (footer?.children[0]) footer.children[0].textContent = running ? 'Running' : 'Stopped';
    const stopBtn = card.querySelector<HTMLElement>('.grid-card-stop-btn');
    if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  }
}
