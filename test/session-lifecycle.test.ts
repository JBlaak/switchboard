import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { SessionLifecycle } from '../src/application/services/session-lifecycle';
import {
  fakeIdeBridge, fakePty, fakeRenderer, fakeTerminals, fakeTimers, silentLog,
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
  const ideBridge = fakeIdeBridge();
  const timers = fakeTimers();

  const lifecycle = new SessionLifecycle({
    registry, terminals, renderer, ideBridge, remote: noRemote, timers, log: silentLog,
  });

  const addSession = (id: string, extra: Partial<ActiveSession> = {}): ActiveSession & { pty: FakePty } => {
    const session = new ActiveSession({
      pty: fakePty(),
      projectPath: '/repo',
      projectFolder: '-repo',
      knownTranscriptIds: new Set(),
      sessionSlug: null,
      isPlainTerminal: false,
      forkFrom: null,
      ideBridge: null,
      remote: null,
      openedAt: 0,
    });
    Object.assign(session, extra);
    registry.add(id, session);
    return session as ActiveSession & { pty: FakePty };
  };

  return { registry, terminals, renderer, ideBridge, timers, lifecycle, addSession };
}

/** The `[pid, signal]` pairs the gateway was asked for. */
const signalsOf = (h: ReturnType<typeof harness>) => h.terminals.signals;

/** The `[sessionId, exitCode]` pairs the renderer was told about. */
const exitsOf = (h: ReturnType<typeof harness>) =>
  h.renderer.only('processExited').map(([, id, code]) => [id, code]);

// --- Retirement ---

test('retiring a session clears the record and tells the renderer', () => {
  const h = harness();
  const session = h.addSession('s1');

  h.lifecycle.retire('s1', session, 0);

  assert.equal(session.exited, true);
  assert.equal(h.registry.has('s1'), false);
  assert.deepEqual(h.ideBridge.stopped, ['s1']);
  assert.deepEqual(exitsOf(h), [['s1', 0]]);
});

test('retiring twice is a no-op', () => {
  // The exit event and the escalation timer can both get here.
  const h = harness();
  const session = h.addSession('s1');

  h.lifecycle.retire('s1', session, 0);
  h.lifecycle.retire('s1', session, 0);

  assert.equal(exitsOf(h).length, 1);
  assert.equal(h.ideBridge.stopped.length, 1);
});

test('a re-keyed session tells the renderer about every id it answered to', () => {
  // A fork or plan-accept re-keys the registry; a sidebar row opened before the
  // transition is still displaying the old id and would stay on "Running".
  const h = harness();
  const session = h.addSession('new-id', {
    realSessionId: 'new-id',
    priorIds: new Set(['temp-id']),
  });

  h.lifecycle.retire('new-id', session, 0);

  assert.deepEqual(exitsOf(h), [['new-id', 0], ['temp-id', 0]]);
});

// --- Escalation ---

test('a stop escalates SIGTERM → SIGKILL → retire the record anyway', () => {
  // The regression: stop sent one signal and left everything else to the PTY's
  // exit event. A process that ignored it kept the row green forever, and
  // clicking stop again only re-sent the same signal.
  const h = harness();
  const session = h.addSession('s1');

  h.lifecycle.stop('s1', session);
  assert.deepEqual(signalsOf(h), [[4242, 'SIGTERM']]);

  h.timers.tick(); // STOP_ESCALATE_MS
  assert.deepEqual(signalsOf(h), [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  // Still on the books: the process might yet exit and report for itself.
  assert.equal(h.registry.has('s1'), true);

  h.timers.tick(); // STOP_GIVE_UP_MS
  assert.equal(h.registry.has('s1'), false);
  assert.deepEqual(exitsOf(h), [['s1', -1]]);
});

test('a session that exits on SIGTERM is never escalated', () => {
  const h = harness();
  const session = h.addSession('s1');

  h.lifecycle.stop('s1', session);
  h.lifecycle.retire('s1', session, 0); // the PTY's exit event lands

  h.timers.tick();
  h.timers.tick();

  assert.deepEqual(signalsOf(h), [[4242, 'SIGTERM']]);
  assert.deepEqual(exitsOf(h), [['s1', 0]]);
});

test('escalation never touches a PTY the session has since replaced', () => {
  // A remote session redials on a new PTY; SIGKILLing that one would take down
  // a connection nobody asked to stop.
  const h = harness();
  const session = h.addSession('s1');

  h.lifecycle.stop('s1', session);
  session.pty = fakePty(5555); // reconnected

  h.timers.tick();
  h.timers.tick();

  assert.deepEqual(signalsOf(h), [[4242, 'SIGTERM']]);
  assert.equal(h.registry.has('s1'), true);
});

// --- Self-healing liveness ---

test('a session whose process vanished without an exit event is retired', () => {
  // `exited` is only ever set from the PTY's exit event, so a process killed
  // from outside would keep its row green for the life of the app. The pid is
  // the ground truth, and checking it here means the next poll clears the row.
  const h = harness({ alive: [] });
  const session = h.addSession('s1');

  assert.deepEqual(h.lifecycle.runningSessionIds(), []);
  assert.equal(session.retired, true);
  assert.deepEqual(exitsOf(h), [['s1', -1]]);
});

test('a live session is reported running', () => {
  const h = harness();
  h.addSession('s1');
  assert.deepEqual(h.lifecycle.runningSessionIds(), ['s1']);
});

// --- Wiring the stream ---

test('a busy title is forwarded once, not per repaint', () => {
  // The CLI repaints its title many times a second; only the transitions are
  // worth an IPC message.
  const h = harness();
  const session = h.addSession('s1');
  h.lifecycle.wire('s1', session);

  session.pty.emitData('\x1b]0;⠋ working\x07');
  session.pty.emitData('\x1b]0;⠙ working\x07');
  session.pty.emitData('\x1b]0;✳ done\x07');

  assert.deepEqual(
    h.renderer.only('cliBusyState').map(([, id, busy]) => [id, busy]),
    [['s1', true], ['s1', false]]);
});

test('an exit with no remote observer retires the session', () => {
  const h = harness();
  const session = h.addSession('s1');
  h.lifecycle.wire('s1', session);

  session.pty.emitExit(3);

  assert.equal(h.registry.has('s1'), false);
  assert.deepEqual(exitsOf(h), [['s1', 3]]);
});

test('output is buffered for the next renderer that attaches', () => {
  const h = harness();
  const session = h.addSession('s1');
  h.lifecycle.wire('s1', session);

  session.pty.emitData('hello ');
  session.pty.emitData('world');

  // Sent live once each…
  assert.deepEqual(h.renderer.only('terminalData').map(([, , data]) => data), ['hello ', 'world']);

  // …and replayed on reattach, with the cursor hidden after it.
  h.renderer.events.length = 0;
  h.lifecycle.replayTo('s1', session);
  assert.deepEqual(
    h.renderer.only('terminalData').map(([, , data]) => data),
    ['hello ', 'world', '\x1b[?25l']);
});
