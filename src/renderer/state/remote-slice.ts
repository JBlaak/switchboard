/**
 * Where each remote session's connection stands, as the main process last
 * said, plus the one shared clock the countdowns run on.
 *
 * Several cards and the terminal header all show whole seconds; a timer each
 * would be both wasteful and visibly out of step, so one tick (`remoteTick`)
 * runs while some connection is in flight and everything reads `tickAt`.
 */
import { isConnectionInFlight } from '../../domain/remote/remote-status';
import { withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';
import type { RemoteStatusPayload, RemoteStatusView } from '../../domain/remote/remote-status';

export interface RemoteState {
  /** sessionId → the last status main sent for it. */
  readonly statuses: IdRecord<RemoteStatusView>;
  /** When the shared countdown clock last ticked; 0 before it ever has. */
  readonly tickAt: number;
}

export const initialRemoteState: RemoteState = { statuses: {}, tickAt: 0 };

export function remoteReducer(state: RemoteState, event: RendererEvent): RemoteState {
  switch (event.type) {
    case 'remoteStatus':
      // A session that disconnected has no connection left to narrate.
      if (event.status.phase === 'disconnected') return forget(state, event.sessionId);
      return {
        ...state,
        statuses: withEntry(state.statuses, event.sessionId, resolveStatus(event.status, event.receivedAt)),
      };

    case 'remoteStatusForgotten':
      return forget(state, event.sessionId);

    case 'remoteTick':
      return state.tickAt === event.at ? state : { ...state, tickAt: event.at };

    default:
      return state;
  }
}

/**
 * A status with its relative timings resolved against the clock it arrived by.
 *
 * `delayMs` is a duration measured from whenever main sent it, which is useless
 * for rendering a countdown after the fact — so it becomes an absolute
 * `retryAt`. `startedAt` is stamped for the same reason, so a connecting card
 * can count up without main having to send a tick every second.
 */
export function resolveStatus(status: RemoteStatusPayload, now: number): RemoteStatusView {
  const stored: RemoteStatusView = { ...status };
  if (status.phase === 'connecting') stored.startedAt = now;
  if (status.phase === 'retrying') stored.retryAt = now + (status.delayMs ?? 0);
  return stored;
}

/** The sessions whose countdown is still moving. */
export function sessionsInFlightIn(state: RemoteState): string[] {
  return Object.entries(state.statuses)
    .filter(([, status]) => isConnectionInFlight(status))
    .map(([id]) => id);
}

function forget(state: RemoteState, sessionId: string): RemoteState {
  const statuses = withoutEntry(state.statuses, sessionId);
  return statuses === state.statuses ? state : { ...state, statuses };
}
