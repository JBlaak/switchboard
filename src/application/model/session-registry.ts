/**
 * The live sessions, by id.
 *
 * A plain map would almost do, except that a session's id changes underneath
 * it: a fork or a plan-accept re-keys a running session, and a sidebar row (or
 * a second window, or a stop request already in flight) is still holding the id
 * it had before. So the registry remembers every id a session has answered to
 * and can be asked by any of them.
 */
import type { ActiveSession } from './active-session';

export class SessionRegistry {
  readonly #byId = new Map<string, ActiveSession>();

  get size(): number {
    return this.#byId.size;
  }

  get(sessionId: string): ActiveSession | undefined {
    return this.#byId.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.#byId.has(sessionId);
  }

  add(sessionId: string, session: ActiveSession): void {
    this.#byId.set(sessionId, session);
  }

  delete(sessionId: string): boolean {
    return this.#byId.delete(sessionId);
  }

  /**
   * Every entry as a snapshot.
   *
   * Callers iterate while retiring sessions, which deletes from the map; a live
   * iterator would skip entries.
   */
  snapshot(): [string, ActiveSession][] {
    return [...this.#byId];
  }

  /**
   * Look up a session by any id it has answered to.
   *
   * A stop aimed at an id the map no longer knows used to report "not running"
   * while the PTY kept going.
   */
  find(sessionId: string): { key: string; session: ActiveSession } | null {
    const direct = this.#byId.get(sessionId);
    if (direct) return { key: sessionId, session: direct };
    for (const [key, session] of this.#byId) {
      if (session.priorIds?.has(sessionId)) return { key, session };
    }
    return null;
  }

  /**
   * Move a session to a new id, remembering the one it is leaving behind.
   */
  rekey(oldSessionId: string, newSessionId: string): void {
    const session = this.#byId.get(oldSessionId);
    if (!session) return;
    session.priorIds = session.priorIds ?? new Set();
    session.priorIds.add(oldSessionId);
    session.realSessionId = newSessionId;
    this.#byId.delete(oldSessionId);
    this.#byId.set(newSessionId, session);
  }
}
