import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { SessionLifecycle, type RemoteObserver } from '../src/application/services/session-lifecycle';
import {
  PASTE_END, PASTE_START, PtySessionPrompter, SUBMIT_DELAY_MS, pasteBytes,
} from '../src/infrastructure/pty/session-prompter';
import { fakePty, fakeRenderer, fakeTerminals, fakeTimers, silentLog, type FakePty } from './support/fakes';
import type { Timers } from '../src/application/ports/clock';

/**
 * The prompter is wired the way the composition root wires it: a real
 * registry and lifecycle, a fake PTY whose output carries the CLI's OSC
 * signals, and timers that record what they were asked to wait for.
 */

const noRemote: RemoteObserver = { observeOutput() {}, handleExit: () => false, markDisconnected() {} };

const IDLE_TITLE = '\x1b]0;✳ Claude Code\x07';
const BUSY_TITLE = '\x1b]0;⠋ Working\x07';

function harness() {
  const registry = new SessionRegistry();
  const timers = fakeTimers();
  const delays: number[] = [];
  const recordingTimers: Timers = {
    ...timers,
    setTimeout(fn, ms) { delays.push(ms); return timers.setTimeout(fn, ms); },
  };
  const prompter = new PtySessionPrompter({ sessions: registry, timers: recordingTimers, log: silentLog });
  const lifecycle = new SessionLifecycle({
    registry, terminals: fakeTerminals(), renderer: fakeRenderer(), remote: noRemote, timers, log: silentLog,
    cliState: prompter,
  });
  const start = (id: string, { plain = false } = {}): ActiveSession & { pty: FakePty } => {
    const session = new ActiveSession({
      pty: fakePty(), projectPath: '/repo', projectFolder: '-repo', knownTranscriptIds: new Set(),
      sessionSlug: null, isPlainTerminal: plain, remote: null, openedAt: 0,
    });
    registry.add(id, session);
    lifecycle.wire(id, session);
    return session as ActiveSession & { pty: FakePty };
  };
  return { registry, timers, delays, prompter, lifecycle, start };
}

test('a prompt is a bracketed paste, so its lines arrive as one message', () => {
  /* When */
  const bytes = pasteBytes('one\ntwo');

  /* Then */
  assert.equal(bytes, '\x1b[200~one\ntwo\x1b[201~');
  assert.equal(PASTE_START, '\x1b[200~');
  assert.equal(PASTE_END, '\x1b[201~');
});

test('nothing in the prompt can close the paste early or press Enter in it', () => {
  /* Given */
  // A CI log tail with colour codes, a stray paste-end, CRLF line ends and a bell.
  const prompt = 'Log tail:\r\n\x1b[31merror\x1b[0m: boom\x1b[201~\rnext\x07\tok';

  /* When */
  const bytes = pasteBytes(prompt);

  /* Then */
  assert.equal(bytes, '\x1b[200~Log tail:\n[31merror[0m: boom[201~\nnext\tok\x1b[201~');
});

test('send writes the paste, then Enter as a write of its own a moment later', () => {
  /* Given */
  const { start, prompter, timers, delays } = harness();
  const session = start('s1');
  session.pty.emitData(IDLE_TITLE);

  /* When */
  prompter.send('s1', 'Ship PR #12.\nThen pull main.');

  /* Then */
  assert.deepEqual(session.pty.writes, ['\x1b[200~Ship PR #12.\nThen pull main.\x1b[201~']);
  assert.deepEqual(delays, [SUBMIT_DELAY_MS]);

  /* When */
  timers.tick();

  /* Then */
  assert.deepEqual(session.pty.writes, ['\x1b[200~Ship PR #12.\nThen pull main.\x1b[201~', '\r']);
});

test('Enter is not pressed into a session that ended after the paste', () => {
  /* Given */
  const { start, prompter, timers } = harness();
  const session = start('s1');
  prompter.send('s1', 'hi');
  session.exited = true;

  /* When */
  timers.tick();

  /* Then */
  assert.deepEqual(session.pty.writes, ['\x1b[200~hi\x1b[201~']);
});

test('nothing is written to a session that is not running', () => {
  /* Given */
  const { prompter } = harness();

  /* When */
  const act = () => prompter.send('nobody', 'hi');

  /* Then */
  assert.doesNotThrow(act);
  assert.equal(prompter.runningId('nobody'), null);
});

test('nothing is written to a plain terminal', () => {
  /* Given */
  const { start, prompter } = harness();
  const plain = start('t1', { plain: true });

  /* When */
  prompter.send('t1', 'hi');

  /* Then */
  assert.deepEqual(plain.pty.writes, []);
  assert.equal(prompter.runningId('t1'), null);
});

test('busy until the CLI shows its prompt, busy mid-turn, idle at its prompt', () => {
  /* Given */
  const { start, prompter } = harness();

  /* When */
  const session = start('s1');

  /* Then */
  assert.equal(prompter.isBusy('s1'), true, 'started, not at its prompt yet');

  /* When */
  session.pty.emitData(IDLE_TITLE);

  /* Then */
  assert.equal(prompter.isBusy('s1'), false);

  /* When */
  session.pty.emitData(BUSY_TITLE);

  /* Then */
  assert.equal(prompter.isBusy('s1'), true);

  /* When */
  session.pty.emitData(IDLE_TITLE);

  /* Then */
  assert.equal(prompter.isBusy('s1'), false);
});

test('a session that is not running counts as busy', () => {
  /* Given */
  const { prompter } = harness();

  /* When */
  const busy = prompter.isBusy('nobody');

  /* Then */
  assert.equal(busy, true, 'not running');
});

test('onIdle hears the first prompt and every end of a turn, until disposed', () => {
  /* Given */
  const { start, prompter } = harness();
  const session = start('s1');
  let idles = 0;
  const listener = prompter.onIdle('s1', () => idles++);

  /* When */
  session.pty.emitData(IDLE_TITLE);

  /* Then */
  assert.equal(idles, 1, 'ready');

  /* When */
  session.pty.emitData(IDLE_TITLE);

  /* Then */
  assert.equal(idles, 1, 'a repaint of the same title is not another idle');

  /* When */
  session.pty.emitData(BUSY_TITLE);

  /* Then */
  assert.equal(idles, 1);

  /* When */
  session.pty.emitData(IDLE_TITLE);

  /* Then */
  assert.equal(idles, 2, 'the turn ended');

  /* When */
  listener.dispose();
  session.pty.emitData(BUSY_TITLE + IDLE_TITLE);

  /* Then */
  assert.equal(idles, 2);
});

function movedSession() {
  const h = harness();
  const session = h.start('old');
  session.pty.emitData(IDLE_TITLE);
  let idles = 0;
  h.prompter.onIdle('old', () => idles++);
  h.registry.rekey('old', 'new');
  return { ...h, session, idles: () => idles };
}

test('a session that moved to a new id is still found by the old one', () => {
  /* Given */
  const { prompter } = movedSession();

  /* When */
  const running = prompter.runningId('old');

  /* Then */
  assert.equal(running, 'new');
});

test('a session that moved to a new id is still heard by a listener on the old one', () => {
  /* Given */
  const { session, idles } = movedSession();

  /* When */
  session.pty.emitData(BUSY_TITLE + IDLE_TITLE);

  /* Then */
  assert.equal(idles(), 1);
});

test('a session that moved to a new id is still sent to by the old one', () => {
  /* Given */
  const { session, prompter } = movedSession();

  /* When */
  prompter.send('old', 'hi');

  /* Then */
  assert.deepEqual(session.pty.writes, ['\x1b[200~hi\x1b[201~']);
});

test('onExit hears the process end, under any id the session went by, once it is no longer running', () => {
  /* Given */
  const { start, prompter, registry } = harness();
  const session = start('old');
  registry.rekey('old', 'new');
  const heard: Array<string | null> = [];
  prompter.onExit('old', () => heard.push(prompter.runningId('new')));
  const other = prompter.onExit('new', () => heard.push('new'));
  other.dispose();

  /* When */
  session.pty.emitExit(0);

  /* Then */
  assert.deepEqual(heard, [null]);
});
