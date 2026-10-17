/**
 * What a remote connection's status leaves behind beyond the card.
 *
 * Two surfaces, deliberately. The card (`ui/remote/RemoteCard`) carries the
 * live state — what we are doing, to which host, how long it has left, what
 * you can do about it — and renders from the store. The scrollback keeps a
 * one-line record of each break, so the reason is still there afterwards;
 * those lines are written here, straight into the terminal, because terminal
 * output never goes through React.
 *
 * Reconnects are driven by the main process; this only reports them.
 */
import { COLOUR_WARN, statusBanner } from '../../../domain/terminal/ansi';
import { dispatch } from '../../state/app-store';
import { openSessions, view } from '../../state/session-store';
import { updateTerminalHeader } from '../sessions/terminal-header';
import { remoteLogLine } from './log-line';
import type { RemoteStatusPayload, RemoteStatusView } from '../../../domain/remote/remote-status';

/** How long the green "reconnected" beat stays before the card steps aside. */
const CONNECTED_BEAT_MS = 500;

/**
 * Follow up on a status the main process sent.
 *
 * Called after the store has recorded the status (see `remote-slice`), so
 * `previous` is the one it replaced.
 */
export function handleRemoteStatus(
  sessionId: string, status: RemoteStatusPayload, previous: RemoteStatusView | undefined,
): void {
  const line = remoteLogLine(status, previous);
  if (line) writeStatusLine(sessionId, line.text, line.warn ? COLOUR_WARN : undefined);

  // A connect after a numbered attempt is a reconnect: the card holds a green
  // beat (see `remote-slice`) that this timer ends.
  if (status.phase === 'connected' && previous?.attempt) {
    setTimeout(() => dispatch({ type: 'remoteConnectedBeatEnded', sessionId }), CONNECTED_BEAT_MS);
  }

  if (sessionId === view.activeSessionId) updateTerminalHeader();
}

/**
 * A permanent line in the scrollback.
 *
 * In the same dim rule as the session-exit banner, so status reads as chrome
 * rather than output from the remote host.
 */
function writeStatusLine(sessionId: string, text: string, colour?: string): void {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  try {
    entry.terminal.write(statusBanner(text, colour));
  } catch {
    // The terminal was disposed between the status arriving and this write.
  }
}
