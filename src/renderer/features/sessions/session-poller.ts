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
import { clearActivity } from '../../state/activity-store';
import { getState } from '../../state/app-store';
import { view } from '../../state/session-store';
import { updateTerminalHeader } from './terminal-header';

const POLL_FAST_MS = 3000;
const POLL_IDLE_MS = 30000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export async function pollActiveSessions(): Promise<void> {
  try {
    view.activePtyIds = new Set(await window.api.getActiveSessions());
    clearStoppedActivity();
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
 * Nothing is running under a session the poll did not report, so it cannot be
 * busy, ready or waiting any more.
 *
 * The rows show the running state straight from the poll's answer; this only
 * clears the marks a session that died without saying so would keep.
 */
function clearStoppedActivity(): void {
  const { activity, view: { activePtyIds } } = getState();
  const marked = new Set([
    ...Object.keys(activity.attention), ...Object.keys(activity.ready),
    ...Object.keys(activity.busy), ...Object.keys(activity.agents),
  ]);
  for (const sessionId of marked) {
    if (!activePtyIds.has(sessionId)) clearActivity(sessionId);
  }
}
