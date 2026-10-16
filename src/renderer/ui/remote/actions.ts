/**
 * The connection card's two buttons.
 *
 * Both take the session id as of the click, which the card reads off its
 * terminal slot: a re-key moves the slot, and the card with it, to the new id.
 */
import { openSession } from '../../features/sessions/session-actions';
import { openSessions, sessionMap } from '../../state/session-store';

/**
 * "Retry now".
 *
 * While the session is still held by the main process this just short-circuits
 * the backoff; once it has been retired — retries exhausted, so the row went
 * back to Stopped — the only way back is a fresh open.
 */
export async function retryRemote(sessionId: string): Promise<void> {
  const entry = openSessions.get(sessionId);
  if (entry && !entry.closed) {
    const result = await window.api.reconnectRemote(sessionId).catch(() => null);
    if (result?.ok) return;
  }
  const session = sessionMap.get(sessionId) || entry?.session;
  if (session) void openSession(session);
}

/**
 * "Stop trying".
 *
 * The tmux session on the far end is untouched by this, so there is nothing
 * to confirm — it only stops Switchboard dialling.
 */
export function stopTrying(sessionId: string): void {
  void window.api.stopSession(sessionId);
}
