/**
 * What the connection card says, from the stored status plus the clock.
 *
 * Everything it shows is derived, so the per-second tick is just this
 * function again with a later `now`.
 */
import type { RemoteStatusView } from '../../../domain/remote/remote-status';

export interface RemoteCardCopy {
  /** The headline: what the connection is doing. */
  readonly status: string;
  /** The line under the bar: the attempt, the elapsed time, the reason. */
  readonly detail: string;
}

export function remoteCardCopy(status: RemoteStatusView, now: number): RemoteCardCopy {
  const attemptOf = status.maxAttempts ? `attempt ${status.attempt} of ${status.maxAttempts}` : '';

  switch (status.phase) {
    case 'connecting': {
      // Counting up toward a limit the user can see coming beats an
      // indeterminate spinner that could mean anything.
      const seconds = Math.floor((now - (status.startedAt ?? now)) / 1000);
      return {
        status: status.attempt ? 'Reconnecting' : 'Connecting',
        detail: [attemptOf, seconds >= 1 ? `${seconds}s` : ''].filter(Boolean).join(' · '),
      };
    }
    case 'retrying': {
      const seconds = Math.max(0, Math.ceil(((status.retryAt ?? 0) - now) / 1000));
      return {
        status: seconds > 0 ? `Reconnecting in ${seconds}s` : 'Reconnecting…',
        detail: [status.reason, attemptOf].filter(Boolean).join(' · '),
      };
    }
    case 'failed':
      return { status: status.everConnected ? 'Lost connection' : 'Could not connect', detail: status.reason || '' };
    case 'connected':
      return { status: 'Connected', detail: '' };
    default:
      return { status: '', detail: '' };
  }
}
