/**
 * What a remote session's connection is doing, as the UI is told about it.
 *
 * A remote session's terminal is empty until ssh says something, and ssh can
 * take a long time to say anything — a sleeping host, a 1Password approval, a
 * banner exchange that never completes. Without a status of its own the screen
 * is indistinguishable from a frozen app, so the connection narrates itself.
 */

export type RemotePhase = 'connecting' | 'connected' | 'retrying' | 'disconnected' | 'failed';

/**
 * Connection state as the main process sends it.
 *
 * Which fields are populated depends on the phase — `retrying` carries the
 * backoff, `failed` carries how many attempts were spent — so they are all
 * optional rather than split into a union the render helpers would have to
 * narrow at every use.
 */
export interface RemoteStatusPayload {
  phase: RemotePhase;
  /** "user@host" — what the card shows you are connecting to. */
  target?: string;
  reason?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Total attempts spent, sent with `failed`. */
  attempts?: number;
  /** How long until the next dial; the renderer turns this into `retryAt`. */
  delayMs?: number;
  everConnected?: boolean;
}

/**
 * The renderer's stored copy of a status.
 *
 * `delayMs` is a duration measured from whenever main sent it, which is useless
 * for rendering a countdown after the fact, so on receipt it is resolved against
 * the local clock into `retryAt`.
 */
export interface RemoteStatusView extends RemoteStatusPayload {
  retryAt?: number;
  /** When this connect attempt began locally, for the card's elapsed counter. */
  startedAt?: number;
}

/**
 * Header label for a remote session mid-connect.
 *
 * Null means the connection is not in flight and the normal running/stopped
 * label applies — while connecting or waiting out a reconnect a session is
 * neither, and saying either is misleading.
 */
export function remoteStatusLabel(
  status: RemoteStatusView | null | undefined,
  now = Date.now(),
): string | null {
  if (!status) return null;
  if (status.phase === 'connecting') return status.attempt ? 'Reconnecting…' : 'Connecting…';
  if (status.phase === 'retrying') {
    const secs = Math.max(0, Math.ceil(((status.retryAt ?? 0) - now) / 1000));
    return secs > 0 ? `Reconnecting in ${secs}s` : 'Reconnecting…';
  }
  return null;
}

/** True while the connection is between attempts rather than settled. */
export function isConnectionInFlight(status: RemoteStatusView | null | undefined): boolean {
  return status?.phase === 'connecting' || status?.phase === 'retrying';
}
