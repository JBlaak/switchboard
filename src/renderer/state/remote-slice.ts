/**
 * Where each remote session's connection stands, as the main process last
 * said, what its connection card shows, plus the one shared clock the
 * countdowns run on.
 *
 * Several cards and the terminal header all show whole seconds; a timer each
 * would be both wasteful and visibly out of step, so one tick (`remoteTick`,
 * from `remote-ticker`) runs while some connection is in flight and
 * everything reads `tickAt`.
 */
import { isConnectionInFlight } from '../../domain/remote/remote-status';
import { movedEntry, withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';
import type { RemoteStatusPayload, RemoteStatusView } from '../../domain/remote/remote-status';

/**
 * What the connecting bar fills toward.
 *
 * Matches ssh's own ConnectTimeout, so the bar reaching the end means the
 * attempt has actually run out rather than the animation guessing.
 */
export const CONNECT_TIMEOUT_MS = 10000;

/** What a session's connection card shows beyond the status itself. */
export interface RemoteCardView {
  /**
   * The green "Connected" beat after a reconnect is up. On a first connect
   * the tmux repaint says it well enough, so there is no beat.
   */
  readonly beat: boolean;
  /**
   * Counts the bar's runs. Each attempt — a dial or a backoff — starts a new
   * one, and a new run is a new fill element, which is what replays its
   * animation.
   */
  readonly barRun: number;
  /** How long the current run lasts; absent before the first. */
  readonly barMs?: number;
}

export interface RemoteState {
  /** sessionId → the last status main sent for it. */
  readonly statuses: IdRecord<RemoteStatusView>;
  /** sessionId → its connection card; there is one beside every stored status. */
  readonly cards: IdRecord<RemoteCardView>;
  /** When the shared countdown clock last ticked; 0 before it ever has. */
  readonly tickAt: number;
}

export const initialRemoteState: RemoteState = { statuses: {}, cards: {}, tickAt: 0 };

const NO_CARD: RemoteCardView = { beat: false, barRun: 0 };

export function remoteReducer(state: RemoteState, event: RendererEvent): RemoteState {
  switch (event.type) {
    case 'remoteStatus': {
      // A session that disconnected has no connection left to narrate.
      if (event.status.phase === 'disconnected') return forget(state, event.sessionId);
      const previous = state.statuses[event.sessionId];
      return {
        ...state,
        statuses: withEntry(state.statuses, event.sessionId, resolveStatus(event.status, event.receivedAt)),
        cards: withEntry(state.cards, event.sessionId,
          nextCard(state.cards[event.sessionId] ?? NO_CARD, event.status, previous)),
      };
    }

    case 'remoteConnectedBeatEnded': {
      const card = state.cards[event.sessionId];
      if (!card?.beat) return state;
      return { ...state, cards: withEntry(state.cards, event.sessionId, { ...card, beat: false }) };
    }

    case 'remoteStatusForgotten':
      return forget(state, event.sessionId);

    case 'remoteTick':
      return state.tickAt === event.at ? state : { ...state, tickAt: event.at };

    default:
      return state;
  }
}

/**
 * The card after a new status.
 *
 * Only a dial and a backoff restart the bar, over the connect timeout and over
 * the delay respectively; a failure leaves it where it was, and the stylesheet
 * hides it. The beat comes only from a connect that followed a numbered
 * attempt, which is what makes it a reconnect.
 */
function nextCard(
  card: RemoteCardView, status: RemoteStatusPayload, previous: RemoteStatusView | undefined,
): RemoteCardView {
  switch (status.phase) {
    case 'connecting':
      return { beat: false, barRun: card.barRun + 1, barMs: CONNECT_TIMEOUT_MS };
    case 'retrying':
      return { beat: false, barRun: card.barRun + 1, barMs: status.delayMs ?? 0 };
    case 'connected':
      return { ...card, beat: !!previous?.attempt };
    default:
      return card.beat ? { ...card, beat: false } : card;
  }
}

/**
 * Whether a session's card is up: while its connection is in flight or has
 * failed, and for the beat after a reconnect.
 */
export function remoteCardShownIn(state: RemoteState, sessionId: string): boolean {
  const status = state.statuses[sessionId];
  if (!status) return false;
  if (status.phase === 'connected') return !!state.cards[sessionId]?.beat;
  return isConnectionInFlight(status) || status.phase === 'failed';
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

/** A re-keyed session's connection is the same connection; it keeps its status and its card. */
export function rekeyRemote(state: RemoteState, oldId: string, newId: string): RemoteState {
  const statuses = movedEntry(state.statuses, oldId, newId);
  const cards = movedEntry(state.cards, oldId, newId);
  return statuses === state.statuses && cards === state.cards ? state : { ...state, statuses, cards };
}

/** The sessions whose countdown is still moving. */
export function sessionsInFlightIn(state: RemoteState): string[] {
  return Object.entries(state.statuses)
    .filter(([, status]) => isConnectionInFlight(status))
    .map(([id]) => id);
}

function forget(state: RemoteState, sessionId: string): RemoteState {
  const statuses = withoutEntry(state.statuses, sessionId);
  const cards = withoutEntry(state.cards, sessionId);
  return statuses === state.statuses && cards === state.cards ? state : { ...state, statuses, cards };
}
