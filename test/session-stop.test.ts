import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BrowserWindow } from 'electron';
import * as sessionStop from '../src/main/session-stop.js';
import type { StopTimers } from '../src/main/session-stop.js';
import type { ActiveSession, ActiveSessionMap } from '../src/main/session-types.js';
const {
  isPtyAlive, signalSessionTree, retireSession, stopSessionTree, findActiveSession,
} = sessionStop;

// A harness standing in for the bits of main.js these helpers reach into.
// `kill` records every signal instead of sending it, and `alive` decides which
// pids the fake kernel still knows about.
/** One `kill()` the fake kernel saw: the pid (negative for a process group). */
type RecordedSignal = [number | string, NodeJS.Signals | 0 | string];
/** One IPC message the fake window received. */
type RecordedSend = [string, string, number];

interface Harness {
  signals: RecordedSignal[];
  sent: RecordedSend[];
  mcpShutdown: string[];
  activeSessions: ActiveSessionMap;
  timers: StopTimers;
  /** Run one round of due callbacks; each may schedule the next rung. */
  tick: () => void;
  addSession: (id: string, extra?: Partial<ActiveSession>) => ActiveSession;
}

interface HarnessOptions {
  /** The pids the fake kernel still knows about. */
  alive?: Set<number>;
  killThrows?: ((pid: number, signal: NodeJS.Signals | 0) => void) | null;
}

function harness({ alive = new Set<number>(), killThrows = null }: HarnessOptions = {}): Harness {
  const signals: RecordedSignal[] = [];
  const sent: RecordedSend[] = [];
  const mcpShutdown: string[] = [];
  const activeSessions: ActiveSessionMap = new Map();

  // A fake clock, so the escalation ladder can be walked without waiting on it.
  let seq = 0;
  const scheduled = new Map<number, { fn: () => void; at: number }>();
  const timers: StopTimers = {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      scheduled.set(id, { fn, at: ms });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimeout: (id) => { scheduled.delete(id as unknown as number); },
  };
  const tick = () => {
    for (const [id, { fn }] of [...scheduled]) { scheduled.delete(id); fn(); }
  };
  // Only the two members retireSession touches.
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, id: string, code: number) => sent.push([channel, id, code]) },
  } as unknown as BrowserWindow;

  sessionStop.init({
    activeSessions,
    getMainWindow: () => win,
    log: { warn() {}, info() {} },
    shutdownMcpServer: (id) => { mcpShutdown.push(id); },
    timers,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (killThrows) killThrows(pid, signal);
      if (signal === 0 && !alive.has(pid)) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
    },
  });

  const addSession = (id: string, extra: Partial<ActiveSession> = {}): ActiveSession => {
    const session = {
      pty: { pid: 4242, kill() { signals.push(['node-pty', 'fallback']); } },
      exited: false,
      ...extra,
    } as unknown as ActiveSession;
    activeSessions.set(id, session);
    return session;
  };

  return { signals, sent, mcpShutdown, activeSessions, timers, tick, addSession };
}

// --- Signalling the tree, not just the shell ---

test('a stop signals the process group, not the single pid', () => {
  // The regression: node-pty's kill() signals the shell alone, but sessions run
  // as `zsh -l -i -c 'claude …'` (with a preLaunchCmd, another process again),
  // so `claude` could outlive the row that owned it.
  const h = harness({ alive: new Set([4242]) });
  const session = h.addSession('s1');
  signalSessionTree(session, 'SIGTERM');
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM']]);
});

test('signalling falls back to node-pty when there is no process group', () => {
  // Windows has no process groups; node-pty kills the job object there instead.
  const h = harness({ killThrows: () => { throw new Error('EPERM'); } });
  const session = h.addSession('s1');
  assert.equal(signalSessionTree(session, 'SIGTERM'), true);
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM'], ['node-pty', 'fallback']]);
});

// --- Liveness ---

test('a live pid reads alive, a reaped one does not', () => {
  const h = harness({ alive: new Set([4242]) });
  assert.equal(isPtyAlive(h.addSession('s1')), true);
  // isPtyAlive reads nothing but `pty.pid`, so these stand in for a whole session.
  assert.equal(isPtyAlive({ pty: { pid: 9999 } } as unknown as ActiveSession), false);
  assert.equal(isPtyAlive({ pty: null } as unknown as ActiveSession), false);
});

test("a pid we are not allowed to signal still counts as alive", () => {
  const h = harness({
    killThrows: (pid, signal) => {
      if (signal === 0) { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; }
    },
  });
  assert.equal(isPtyAlive(h.addSession('s1')), true);
});

// --- Retirement ---

test('retiring a session clears the record and tells the renderer', () => {
  const h = harness({ alive: new Set([4242]) });
  const session = h.addSession('s1');
  retireSession('s1', session, 0);
  assert.equal(session.exited, true);
  assert.equal(h.activeSessions.has('s1'), false);
  assert.deepEqual(h.mcpShutdown, ['s1']);
  assert.deepEqual(h.sent, [['process-exited', 's1', 0]]);
});

test('retiring twice is a no-op', () => {
  // The exit event and the escalation timer can both get here.
  const h = harness({ alive: new Set([4242]) });
  const session = h.addSession('s1');
  retireSession('s1', session, 0);
  retireSession('s1', session, 0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.mcpShutdown.length, 1);
});

test('a re-keyed session tells the renderer about every id it answered to', () => {
  // A fork or plan-accept re-keys the map; a sidebar row opened before the
  // transition is still displaying the old id and would stay on "Running".
  const h = harness({ alive: new Set([4242]) });
  const session = h.addSession('new-id', {
    realSessionId: 'new-id',
    priorIds: new Set(['temp-id']),
  });
  retireSession('new-id', session, 0);
  assert.deepEqual(h.sent, [
    ['process-exited', 'new-id', 0],
    ['process-exited', 'temp-id', 0],
  ]);
});

// --- Escalation ---

test('a stop escalates SIGTERM → SIGKILL → retire the record anyway', () => {
  // The regression: stop sent one signal and left everything else to the PTY's
  // exit event. A process that ignored it kept the row green forever, and
  // clicking stop again only re-sent the same signal.
  const h = harness({ alive: new Set([4242]) });
  const session = h.addSession('s1');

  stopSessionTree('s1', session);
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM']]);

  h.tick(); // STOP_ESCALATE_MS
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  // Still on the books: the process might yet exit and report for itself.
  assert.equal(h.activeSessions.has('s1'), true);

  h.tick(); // STOP_GIVE_UP_MS
  assert.equal(h.activeSessions.has('s1'), false);
  assert.deepEqual(h.sent, [['process-exited', 's1', -1]]);
});

test('a session that exits on SIGTERM is never escalated', () => {
  const h = harness({ alive: new Set([4242]) });
  const session = h.addSession('s1');

  stopSessionTree('s1', session);
  retireSession('s1', session, 0); // the PTY's exit event lands

  h.tick();
  h.tick();
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM']]);
  assert.deepEqual(h.sent, [['process-exited', 's1', 0]]);
});

test('escalation never touches a PTY the session has since replaced', () => {
  // A remote session redials on a new PTY; SIGKILLing that one would take down
  // a connection nobody asked to stop.
  const h = harness({ alive: new Set([4242]) });
  const session = h.addSession('s1');

  stopSessionTree('s1', session);
  session.pty = { pid: 5555, kill() {} } as unknown as typeof session.pty; // reconnected

  h.tick();
  h.tick();
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM']]);
  assert.equal(h.activeSessions.has('s1'), true);
});

// --- Finding a session by a stale id ---

test('a session is findable by an id it has been re-keyed away from', () => {
  const h = harness({ alive: new Set([4242]) });
  const session = h.addSession('new-id', { priorIds: new Set(['temp-id']) });

  assert.deepEqual(findActiveSession('new-id'), { key: 'new-id', session });
  // The regression: a stop aimed at the pre-fork id reported "not running"
  // while the PTY carried on.
  assert.deepEqual(findActiveSession('temp-id'), { key: 'new-id', session });
  assert.equal(findActiveSession('unknown'), null);
});
