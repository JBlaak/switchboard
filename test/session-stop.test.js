const { test } = require('node:test');
const assert = require('node:assert/strict');

const sessionStop = require('../session-stop');
const {
  isPtyAlive, signalSessionTree, retireSession, stopSessionTree, findActiveSession,
} = sessionStop;

// A harness standing in for the bits of main.js these helpers reach into.
// `kill` records every signal instead of sending it, and `alive` decides which
// pids the fake kernel still knows about.
function harness({ alive = new Set(), killThrows = null } = {}) {
  const ctx = {
    signals: [],
    sent: [],
    mcpShutdown: [],
    activeSessions: new Map(),
  };
  // A fake clock, so the escalation ladder can be walked without waiting on it.
  let seq = 0;
  const scheduled = new Map();
  ctx.timers = {
    setTimeout: (fn, ms) => { const id = ++seq; scheduled.set(id, { fn, at: ms }); return id; },
    clearTimeout: (id) => { scheduled.delete(id); },
  };
  ctx.tick = () => {
    // One round of due callbacks; each may schedule the next rung.
    for (const [id, { fn }] of [...scheduled]) { scheduled.delete(id); fn(); }
  };
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, id, code) => ctx.sent.push([channel, id, code]) },
  };
  sessionStop.init({
    activeSessions: ctx.activeSessions,
    getMainWindow: () => win,
    log: { warn() {}, info() {}, debug() {} },
    shutdownMcpServer: (id) => ctx.mcpShutdown.push(id),
    timers: ctx.timers,
    kill: (pid, signal) => {
      ctx.signals.push([pid, signal]);
      if (killThrows) killThrows(pid, signal);
      if (signal === 0 && !alive.has(pid)) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
    },
  });
  ctx.addSession = (id, extra = {}) => {
    const session = {
      pty: { pid: 4242, kill() { ctx.signals.push(['node-pty', 'fallback']); } },
      exited: false,
      ...extra,
    };
    ctx.activeSessions.set(id, session);
    return session;
  };
  return ctx;
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
  assert.equal(isPtyAlive({ pty: { pid: 9999 } }), false);
  assert.equal(isPtyAlive({ pty: null }), false);
});

test("a pid we are not allowed to signal still counts as alive", () => {
  const h = harness({
    killThrows: (pid, signal) => {
      if (signal === 0) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
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
  session.pty = { pid: 5555, kill() {} }; // reconnected

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
