/**
 * Doubles for the Session work queue's ports: a session the test drives
 * (running or not, busy or idle, exiting, moving to a new id) and a store
 * that keeps its rows in memory, the way SQLite would across a restart.
 */
import type { ActivityStore, StoredAction } from '../../src/application/ports/activity-store';
import type { SessionPrompter } from '../../src/application/ports/session-prompter';

/** A session the test drives: running or not, busy or idle, with its id moving on a fork. */
export class FakePrompter implements SessionPrompter {
  running = new Set<string>(['s1']);
  busy = new Set<string>();
  /** A rekeyed session: old id → the id it goes by now. */
  moved = new Map<string, string>();
  sent: Array<{ sessionId: string; prompt: string }> = [];
  listeners = new Map<string, Set<() => void>>();

  runningId(sessionId: string): string | null {
    const id = this.moved.get(sessionId) ?? sessionId;
    return this.running.has(id) ? id : null;
  }
  isBusy(sessionId: string): boolean {
    const id = this.runningId(sessionId);
    return id === null || this.busy.has(id);
  }
  onIdle(sessionId: string, fn: () => void) {
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(fn);
    this.listeners.set(sessionId, set);
    return { dispose: () => { set.delete(fn); } };
  }
  exitListeners = new Map<string, Set<() => void>>();
  onExit(sessionId: string, fn: () => void) {
    const set = this.exitListeners.get(sessionId) ?? new Set();
    set.add(fn);
    this.exitListeners.set(sessionId, set);
    return { dispose: () => { set.delete(fn); } };
  }
  send(sessionId: string, prompt: string): void {
    this.sent.push({ sessionId, prompt });
  }
  /** The session's process ends: it is no longer running, and every exit listener under its ids hears it. */
  exit(id = 's1') {
    const fns: Array<() => void> = [];
    for (const [listenId, set] of this.exitListeners) {
      if (this.runningId(listenId) === id) fns.push(...set);
    }
    this.running.delete(id);
    this.busy.delete(id);
    for (const fn of fns) fn();
  }
  /** The session starts a turn. */
  goBusy(id = 's1') { this.busy.add(id); }
  /** The session comes to its prompt: every listener under any of its ids hears it. */
  goIdle(id = 's1') {
    this.busy.delete(id);
    for (const [listenId, fns] of this.listeners) {
      if (this.runningId(listenId) === id) for (const fn of [...fns]) fn();
    }
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

export class MemoryStore implements ActivityStore {
  rows: StoredAction[] = [];
  add(action: StoredAction) { this.rows.push({ ...action }); }
  update(id: string, changes: Partial<Pick<StoredAction, 'phase' | 'sentAt' | 'doneAt'>>) {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)));
  }
  remove(id: string) { this.rows = this.rows.filter((r) => r.id !== id); }
  unfinished() { return this.rows.filter((r) => r.phase !== 'done').map((r) => ({ ...r })); }
}
