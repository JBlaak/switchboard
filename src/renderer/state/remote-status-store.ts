/**
 * Where each remote session's connection stands, as the vanilla code reads it,
 * and the timer that drives the shared countdown clock.
 *
 * The statuses live in the store (see `remote-slice`). The timer is a service
 * that dispatches: while some connection is in flight it dispatches
 * `remoteTick` once a second, and stops when none is. The cards and the
 * terminal header repaint off that tick through the listener `bootstrap`
 * registers.
 */
import { dispatch, getState, onEvent } from './app-store';
import { sessionsInFlightIn } from './remote-slice';
import type { RemoteStatusView } from '../../domain/remote/remote-status';

/** sessionId → the last status main sent for it. Read-only; see `forgetStatus`. */
export const remoteStatus = {
  get: (sessionId: string | null | undefined): RemoteStatusView | undefined =>
    sessionId ? getState().remote.statuses[sessionId] : undefined,
  /** Forget a session's status; kept so the old `remoteStatus.delete` reads on. */
  delete: (sessionId: string): void => forgetStatus(sessionId),
};

/** How often the countdowns are repainted. */
const TICK_MS = 1000;

type TickListener = (sessionIds: readonly string[]) => void;

let ticker: ReturnType<typeof setInterval> | null = null;

export function forgetStatus(sessionId: string): void {
  dispatch({ type: 'remoteStatusForgotten', sessionId });
}

/** The sessions whose countdown is still moving. */
export function sessionsInFlight(): string[] {
  return sessionsInFlightIn(getState().remote);
}

/** Register what a tick should repaint. Called once, at boot. */
export function setTickListener(listener: TickListener): void {
  onEvent('remoteTick', () => listener(sessionsInFlight()));
}

/** Start or stop the shared tick, to match whether anything is in flight. */
export function syncTicker(): void {
  const live = sessionsInFlight();

  if (live.length && !ticker) {
    ticker = setInterval(() => {
      dispatch({ type: 'remoteTick', at: Date.now() });
      syncTicker();
    }, TICK_MS);
    return;
  }
  if (!live.length && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
