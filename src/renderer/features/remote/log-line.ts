/**
 * The one-line record a remote connection's status leaves in the scrollback,
 * if any (written by `connection-log`).
 */
import type { RemoteStatusPayload, RemoteStatusView } from '../../../domain/remote/remote-status';

export interface RemoteLogLine {
  readonly text: string;
  /** Said in the warning colour rather than the plain dim rule. */
  readonly warn: boolean;
}

/**
 * What `status` adds to the scrollback, given the status it replaced.
 *
 * A connect after a numbered attempt is a reconnect and is logged; a first
 * connect is not. Every break is logged, so the reason is still there once
 * the card has moved on.
 */
export function remoteLogLine(
  status: RemoteStatusPayload, previous: RemoteStatusView | undefined,
): RemoteLogLine | null {
  const target = status.target || 'the remote host';
  switch (status.phase) {
    case 'connected':
      return previous?.attempt ? { text: 'reconnected', warn: false } : null;
    case 'retrying':
      return {
        text: status.everConnected
          ? `connection lost: ${status.reason}`
          : `could not reach ${target}: ${status.reason}`,
        warn: true,
      };
    case 'failed':
      return { text: `gave up ${status.everConnected ? 'reconnecting to' : 'connecting to'} ${target}`, warn: true };
    default:
      return null;
  }
}
