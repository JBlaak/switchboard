/**
 * Where each remote session's connection stands, as the main process last said.
 *
 * Plus the one shared clock the countdowns run on: several cards and the
 * terminal header all show whole seconds, and a timer each would be both
 * wasteful and visibly out of step. The tick only runs while some connection is
 * actually in flight.
 */
import { isConnectionInFlight } from '../../domain/remote/remote-status';
import type { RemoteStatusPayload, RemoteStatusView } from '../../domain/remote/remote-status';

/** sessionId → the last status main sent for it. */
export const remoteStatus = new Map<string, RemoteStatusView>();

/** How often the countdowns are repainted. */
const TICK_MS = 1000;

type TickListener = (sessionIds: readonly string[]) => void;

let ticker: ReturnType<typeof setInterval> | null = null;
let onTick: TickListener = () => {};

/**
 * Store a status, resolving its relative timings against the local clock.
 *
 * `delayMs` is a duration measured from whenever main sent it, which is useless
 * for rendering a countdown after the fact — so it becomes an absolute
 * `retryAt`. `startedAt` is stamped for the same reason, so a connecting card
 * can count up without main having to send a tick every second.
 */
export function recordStatus(sessionId: string, status: RemoteStatusPayload): RemoteStatusView {
  const now = Date.now();
  const stored: RemoteStatusView = { ...status };
  if (status.phase === 'connecting') stored.startedAt = now;
  if (status.phase === 'retrying') stored.retryAt = now + (status.delayMs ?? 0);
  remoteStatus.set(sessionId, stored);
  return stored;
}

export function forgetStatus(sessionId: string): void {
  remoteStatus.delete(sessionId);
}

/** The sessions whose countdown is still moving. */
export function sessionsInFlight(): string[] {
  return [...remoteStatus].filter(([, status]) => isConnectionInFlight(status)).map(([id]) => id);
}

/** Register what a tick should repaint. Called once, at boot. */
export function setTickListener(listener: TickListener): void {
  onTick = listener;
}

/** Start or stop the shared tick, to match whether anything is in flight. */
export function syncTicker(): void {
  const live = sessionsInFlight();

  if (live.length && !ticker) {
    ticker = setInterval(() => {
      onTick(sessionsInFlight());
      syncTicker();
    }, TICK_MS);
    return;
  }
  if (!live.length && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
