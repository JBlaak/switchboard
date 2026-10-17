import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { SessionLifecycle } from '../src/application/services/session-lifecycle';
import { PROGRAM_STATUS_REPLY } from '../src/domain/terminal/osc';
import {
  fakePty, fakeRenderer, fakeTerminals, fakeTimers, silentLog,
} from './support/fakes';
import type { RemoteObserver } from '../src/application/services/session-lifecycle';
import type { FakePty } from './support/fakes';

/**
 * Retiring a session used to be the sole privilege of its PTY's exit event, so
 * anything that killed a process without that event arriving left the record
 * behind with `exited` false — a row stuck on "Running" that the stop button
 * could only re-signal, never clear. These are the rules that fixed that.
 */

/** A remote observer that does nothing: these tests are all local sessions. */
const noRemote: RemoteObserver = {
  observeOutput() {},
  handleExit: () => false,
  markDisconnected() {},
};

function harness({ alive = [4242] }: { alive?: number[] } = {}) {
  const registry = new SessionRegistry();
  const terminals = fakeTerminals(alive);
  const renderer = fakeRenderer();
  const timers = fakeTimers();

  const lifecycle = new SessionLifecycle({
    registry, terminals, renderer, remote: noRemote, timers, log: silentLog,
  });

  const addSession = (id: string, extra: Partial<ActiveSession> = {}): ActiveSession & { pty: FakePty } => {
    const session = new ActiveSession({
      pty: fakePty(),
      projectPath: '/repo',
      projectFolder: '-repo',
      knownTranscriptIds: new Set(),
      sessionSlug: null,
      isPlainTerminal: false,
      remote: null,
      openedAt: 0,
    });
    Object.assign(session, extra);
    registry.add(id, session);
    return session as ActiveSession & { pty: FakePty };
  };

  return { registry, terminals, renderer, timers, lifecycle, addSession };
}

/** The `[pid, signal]` pairs the gateway was asked for. */
const signalsOf = (h: ReturnType<typeof harness>) => h.terminals.signals;

/** The `[sessionId, exitCode]` pairs the renderer was told about. */
const exitsOf = (h: ReturnType<typeof harness>) =>
  h.renderer.only('processExited').map(([, id, code]) => [id, code]);

// --- Retirement ---

test('retiring a session clears the record and tells the renderer', () => {
  /* Given */
  const h = harness();
  const session = h.addSession('s1');

  /* When */
  h.lifecycle.retire('s1', session, 0);

  /* Then */
  assert.equal(session.exited, true);
  assert.equal(h.registry.has('s1'), false);
  assert.deepEqual(exitsOf(h), [['s1', 0]]);
});

test('retiring twice is a no-op', () => {
  // The exit event and the escalation timer can both get here.

  /* Given */
  const h = harness();
  const session = h.addSession('s1');
  h.lifecycle.retire('s1', session, 0);

  /* When */
  h.lifecycle.retire('s1', session, 0);

  /* Then */
  assert.equal(exitsOf(h).length, 1);
});

test('a re-keyed session tells the renderer about every id it answered to', () => {
  // A fork or plan-accept re-keys the registry; a sidebar row opened before the
  // transition is still displaying the old id and would stay on "Running".

  /* Given */
  const h = harness();
  const session = h.addSession('new-id', {
    realSessionId: 'new-id',
    priorIds: new Set(['temp-id']),
  });

  /* When */
  h.lifecycle.retire('new-id', session, 0);

  /* Then */
  assert.deepEqual(exitsOf(h), [['new-id', 0], ['temp-id', 0]]);
});

// --- Escalation ---

test('a stop escalates SIGTERM → SIGKILL → retire the record anyway', () => {
  // The regression: stop sent one signal and left everything else to the PTY's
  // exit event. A process that ignored it kept the row green forever, and
  // clicking stop again only re-sent the same signal.

  /* Given */
  const h = harness();
  const session = h.addSession('s1');

  /* When */
  h.lifecycle.stop('s1', session);

  /* Then */
  assert.deepEqual(signalsOf(h), [[4242, 'SIGTERM']]);

  /* When */
  h.timers.tick(); // STOP_ESCALATE_MS

  /* Then */
  assert.deepEqual(signalsOf(h), [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  // Still on the books: the process might yet exit and report for itself.
  assert.equal(h.registry.has('s1'), true);

  /* When */
  h.timers.tick(); // STOP_GIVE_UP_MS

  /* Then */
  assert.equal(h.registry.has('s1'), false);
  assert.deepEqual(exitsOf(h), [['s1', -1]]);
});

test('a session that exits on SIGTERM is never escalated', () => {
  /* Given */
  const h = harness();
  const session = h.addSession('s1');
  h.lifecycle.stop('s1', session);
  h.lifecycle.retire('s1', session, 0); // the PTY's exit event lands

  /* When */
  h.timers.tick();
  h.timers.tick();

  /* Then */
  assert.deepEqual(signalsOf(h), [[4242, 'SIGTERM']]);
  assert.deepEqual(exitsOf(h), [['s1', 0]]);
});

test('escalation never touches a PTY the session has since replaced', () => {
  // A remote session redials on a new PTY; SIGKILLing that one would take down
  // a connection nobody asked to stop.

  /* Given */
  const h = harness();
  const session = h.addSession('s1');
  h.lifecycle.stop('s1', session);
  session.pty = fakePty(5555); // reconnected

  /* When */
  h.timers.tick();
  h.timers.tick();

  /* Then */
  assert.deepEqual(signalsOf(h), [[4242, 'SIGTERM']]);
  assert.equal(h.registry.has('s1'), true);
});

// --- Self-healing liveness ---

test('a session whose process vanished without an exit event is retired', () => {
  // `exited` is only ever set from the PTY's exit event, so a process killed
  // from outside would keep its row green for the life of the app. The pid is
  // the ground truth, and checking it here means the next poll clears the row.

  /* Given */
  const h = harness({ alive: [] });
  const session = h.addSession('s1');

  /* When */
  const running = h.lifecycle.runningSessionIds();

  /* Then */
  assert.deepEqual(running, []);
  assert.equal(session.retired, true);
  assert.deepEqual(exitsOf(h), [['s1', -1]]);
});

test('a live session is reported running', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');

  /* When */
  const running = h.lifecycle.runningSessionIds();

  /* Then */
  assert.deepEqual(running, ['s1']);
});

// --- Wiring the stream ---

/** A harness with one session wired to its PTY's stream. */
function wired(id = 's1', extra: Partial<ActiveSession> = {}) {
  const h = harness();
  const session = h.addSession(id, extra);
  h.lifecycle.wire(id, session);
  return { h, session };
}

test('a busy title is forwarded once, not per repaint', () => {
  // The CLI repaints its title many times a second; only the transitions are
  // worth an IPC message.

  /* Given */
  const { h, session } = wired();

  /* When */
  session.pty.emitData('\x1b]0;⠋ working\x07');
  session.pty.emitData('\x1b]0;⠙ working\x07');
  session.pty.emitData('\x1b]0;✳ done\x07');

  /* Then */
  assert.deepEqual(
    h.renderer.only('cliBusyState').map(([, id, busy]) => [id, busy]),
    [['s1', true], ['s1', false]]);
});

test('the 7501 probe is answered straight into the PTY, before the chunk is forwarded', () => {
  // The CLI drops 7501 for the session if xterm.js's DA answer beats ours, and
  // that one has an IPC round trip to make.

  /* Given */
  const { h, session } = wired();
  const order: string[] = [];
  const write = session.pty.write.bind(session.pty);
  session.pty.write = (data: string) => { order.push('reply'); write(data); };
  const terminalData = h.renderer.terminalData;
  h.renderer.terminalData = (id, data) => { order.push('forward'); terminalData(id, data); };

  /* When */
  session.pty.emitData('\x1b]7501;?\x1b\\\x1b[c');

  /* Then */
  assert.deepEqual(session.pty.writes, [PROGRAM_STATUS_REPLY]);
  assert.deepEqual(order, ['reply', 'forward']);
});

test('a plain terminal does not answer the 7501 probe', () => {
  /* Given */
  const { session } = wired('t1', { isPlainTerminal: true } as Partial<ActiveSession>);

  /* When */
  session.pty.emitData('\x1b]7501;?\x1b\\\x1b[c');

  /* Then */
  assert.deepEqual(session.pty.writes, []);
});

/** A wired session that goes idle, working, blocked on a permission, and done. */
function blockedTurn() {
  const { h, session } = wired();
  const msg = Buffer.from('approve Write: /p').toString('base64');
  session.pty.emitData('\x1b]7501;state=idle:app=claude-code\x1b\\');
  session.pty.emitData('\x1b]7501;state=working:app=claude-code\x1b\\');
  session.pty.emitData(`\x1b]7501;state=blocked:app=claude-code:kind=permission:msg=${msg}\x1b\\`);
  session.pty.emitData('\x1b]9;Claude needs your permission\x07');
  session.pty.emitData('\x1b]0;◐ Ok\x07');
  session.pty.emitData('\x1b]7501;state=done:app=claude-code\x1b\\');
  return h;
}

test('7501 reports drive the busy state', () => {
  /* When */
  const h = blockedTurn();

  /* Then */
  assert.deepEqual(
    h.renderer.only('cliBusyState').map(([, id, busy]) => [id, busy]),
    [['s1', true], ['s1', false]]);
});

test('a 7501 block reaches the renderer', () => {
  /* When */
  const h = blockedTurn();

  /* Then */
  assert.deepEqual(h.renderer.only('sessionNeedsAttention'), [['sessionNeedsAttention', 's1']]);
});

test('the OSC 9 notification still reaches the renderer alongside 7501', () => {
  /* When */
  const h = blockedTurn();

  /* Then */
  // The OSC 9 path still runs alongside, for older CLIs.
  assert.deepEqual(
    h.renderer.only('terminalNotification').map(([, , message]) => message),
    ['Claude needs your permission']);
});

/** A wired session whose root works while two subagents come and go. */
function agentsComeAndGo() {
  const { h, session } = wired();
  const title = (text: string) => Buffer.from(text).toString('base64');
  session.pty.emitData('\x1b]7501;state=working:app=claude-code\x1b\\');
  session.pty.emitData(`\x1b]7501;state=working:app=claude-code:id=a:title=${title('Count domain')}\x1b\\`);
  session.pty.emitData(`\x1b]7501;state=working:app=claude-code:id=a:title=${title('Count domain')}\x1b\\`);
  session.pty.emitData(`\x1b]7501;state=working:app=claude-code:id=b:title=${title('Count renderer')}\x1b\\`);
  session.pty.emitData('\x1b]7501;state=clear:id=b\x1b\\');
  session.pty.emitData('\x1b]7501;state=clear\x1b\\');
  return h;
}

test('7501 child records reach the renderer as working agents, once per change', () => {
  /* When */
  const h = agentsComeAndGo();

  /* Then */
  assert.deepEqual(h.renderer.only('sessionAgents').map(([, id, agents]) => [id, agents]), [
    ['s1', [{ id: 'a', title: 'Count domain' }]],
    ['s1', [{ id: 'a', title: 'Count domain' }, { id: 'b', title: 'Count renderer' }]],
    ['s1', [{ id: 'a', title: 'Count domain' }]],
    ['s1', []],
  ]);
});

test('7501 child records do not move the session\'s own busy state', () => {
  /* When */
  const h = agentsComeAndGo();

  /* Then */
  // Subagents do not move the session's own state; only the root's working
  // and the final clear do.
  assert.deepEqual(h.renderer.only('cliBusyState').map(([, , busy]) => busy), [true, false]);
});

test('an exit with no remote observer retires the session', () => {
  /* Given */
  const { h, session } = wired();

  /* When */
  session.pty.emitExit(3);

  /* Then */
  assert.equal(h.registry.has('s1'), false);
  assert.deepEqual(exitsOf(h), [['s1', 3]]);
});

test('output is sent live once per chunk', () => {
  /* Given */
  const { h, session } = wired();

  /* When */
  session.pty.emitData('hello ');
  session.pty.emitData('world');

  /* Then */
  assert.deepEqual(h.renderer.only('terminalData').map(([, , data]) => data), ['hello ', 'world']);
});

test('output is buffered for the next renderer that attaches', () => {
  /* Given */
  const { h, session } = wired();
  session.pty.emitData('hello ');
  session.pty.emitData('world');
  h.renderer.events.length = 0;

  /* When */
  h.lifecycle.replayTo('s1', session);

  /* Then */
  // Replayed on reattach, with the cursor hidden after it.
  assert.deepEqual(
    h.renderer.only('terminalData').map(([, , data]) => data),
    ['hello ', 'world', '\x1b[?25l']);
});
