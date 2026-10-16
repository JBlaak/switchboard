/**
 * A stable local key per session, for the things that must not notice a
 * re-key: element keys, React's keys in the session list, the reflow glide.
 *
 * A session's id is not stable. A fork or an accepted plan gives a running
 * session a new one, and anything keyed by the id alone — a row's element id,
 * a React key — sees the old session vanish and a new one appear, so the row
 * is torn down and rebuilt instead of staying where it is.
 *
 * The key is handed out the first time the renderer sees a session id (a
 * fetched row, a session it just launched) and follows the session across
 * every re-key. The old id gives its key up: if its transcript shows up again
 * as a row of its own, that row is a different session and gets a fresh key.
 */
import { withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';

export interface KeysState {
  /** sessionId → its local key. */
  readonly byId: IdRecord<string>;
  /** The number the next key is made from. */
  readonly next: number;
}

export const initialKeysState: KeysState = { byId: {}, next: 1 };

/**
 * Never the shape of a session id (a UUID, or main's own terminal ids), so a
 * key cannot collide with the id fallback in `sessionKeyIn`.
 */
const keyFor = (n: number): string => `key-${n}`;

export function keysReducer(state: KeysState, event: RendererEvent): KeysState {
  if (event.type !== 'sessionsSeen') return state;
  let byId: Record<string, string> | null = null;
  let next = state.next;
  for (const sessionId of event.sessionIds) {
    if ((byId ?? state.byId)[sessionId] !== undefined) continue;
    byId ??= { ...state.byId };
    byId[sessionId] = keyFor(next++);
  }
  return byId ? { byId, next } : state;
}

/**
 * The new id takes the old id's key, and the old id is forgotten.
 *
 * The old key wins even when the new id was already seen (its transcript can
 * be fetched before the fork event lands): the old key is the row on screen,
 * and keeping it is what keeps that row in place. A session that was never
 * seen has no key to carry.
 */
export function rekeyKeys(state: KeysState, oldId: string, newId: string): KeysState {
  const key = state.byId[oldId];
  if (key === undefined || oldId === newId) return state;
  return { ...state, byId: { ...withoutEntry(state.byId, oldId), [newId]: key } };
}

/**
 * A session's local key.
 *
 * Falls back to the id itself for a session the renderer has not been told
 * about, so a caller always has something unique to key on.
 */
export function sessionKeyIn(state: KeysState, sessionId: string): string {
  return state.byId[sessionId] ?? sessionId;
}
