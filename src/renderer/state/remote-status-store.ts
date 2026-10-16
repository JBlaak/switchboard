/**
 * Where each remote session's connection stands, as the vanilla code reads it.
 *
 * The statuses live in the store (see `remote-slice`); the shared countdown
 * clock is `remote-ticker`'s.
 */
import { dispatch, getState } from './app-store';
import type { RemoteStatusView } from '../../domain/remote/remote-status';

/** sessionId → the last status main sent for it. Read-only; see `forgetStatus`. */
export const remoteStatus = {
  get: (sessionId: string | null | undefined): RemoteStatusView | undefined =>
    sessionId ? getState().remote.statuses[sessionId] : undefined,
  /** Forget a session's status; kept so the old `remoteStatus.delete` reads on. */
  delete: (sessionId: string): void => forgetStatus(sessionId),
};

export function forgetStatus(sessionId: string): void {
  dispatch({ type: 'remoteStatusForgotten', sessionId });
}
