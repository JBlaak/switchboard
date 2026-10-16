import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CliBusyTracker, PROGRAM_STATUS_REPLY, parseProgramStatus, parseTerminalEvents, titleMeansBusy,
} from '../src/domain/terminal/osc';
import type { CliStateChange, TerminalEvent } from '../src/domain/terminal/osc';

/**
 * CLI 2.1.301 broke the title-glyph heuristic — a new spinner, and a title that
 * keeps its last frame after the turn — so a session's state now comes from the
 * Program Status Protocol (OSC 7501) when the CLI speaks it. These pin both the
 * parsing of that protocol and the rule that it wins over the legacy signals.
 */

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const osc7501 = (payload: string, st = '\x1b\\'): string => `\x1b]7501;${payload}${st}`;

// --- Parsing 7501 reports ---

test('a 7501 report parses with either terminator', () => {
  for (const st of ['\x1b\\', '\x07']) {
    assert.deepEqual(parseTerminalEvents(osc7501('state=working:app=claude-code', st)), [
      { kind: 'program-status', state: 'working', app: 'claude-code' },
    ]);
  }
});

test('a blocked report carries its kind as blockedOn and decodes msg', () => {
  const events = parseTerminalEvents(osc7501(
    `state=blocked:app=claude-code:kind=permission:msg=${b64('approve Write: /tmp/zz-probe.txt')}`));
  assert.deepEqual(events, [{
    kind: 'program-status', state: 'blocked', app: 'claude-code',
    blockedOn: 'permission', msg: 'approve Write: /tmp/zz-probe.txt',
  }]);
});

test('a child record keeps its id and its decoded UTF-8 title', () => {
  const events = parseTerminalEvents(osc7501(
    `state=working:app=claude-code:id=a2b4e2746e65ed41b:title=${b64('Count files in src/domain — ✓')}`));
  assert.deepEqual(events, [{
    kind: 'program-status', state: 'working', app: 'claude-code',
    id: 'a2b4e2746e65ed41b', title: 'Count files in src/domain — ✓',
  }]);
});

test('progress is kept only when it is 0–100', () => {
  assert.equal(parseProgramStatus('state=working:progress=42')?.progress, 42);
  assert.equal(parseProgramStatus('state=working:progress=101')?.progress, undefined);
  assert.equal(parseProgramStatus('state=working:progress=-1')?.progress, undefined);
  assert.equal(parseProgramStatus('state=working:progress=abc')?.progress, undefined);
});

test('whitespace around pairs is tolerated', () => {
  assert.deepEqual(parseProgramStatus(' state = done : app = claude-code '), {
    kind: 'program-status', state: 'done', app: 'claude-code',
  });
});

test('malformed pairs and unknown keys are skipped, not fatal', () => {
  assert.deepEqual(parseProgramStatus('garbage:=nokey:state=idle:future=thing'), {
    kind: 'program-status', state: 'idle',
  });
});

test('an unknown blocked kind is dropped but the report stands', () => {
  assert.deepEqual(parseProgramStatus('state=blocked:kind=telepathy'), {
    kind: 'program-status', state: 'blocked',
  });
});

test('a report with no state, or one this version does not know, is ignored', () => {
  assert.equal(parseProgramStatus('app=claude-code'), null);
  assert.equal(parseProgramStatus('state=pondering'), null);
  assert.deepEqual(parseTerminalEvents(osc7501('state=pondering')), []);
});

test('a title or msg with control characters voids the report', () => {
  // Decoded text is shown in the UI; an escape smuggled in through base64 must
  // not get there.
  assert.equal(parseProgramStatus(`state=working:msg=${b64('hi\x1b[31m')}`), null);
  assert.equal(parseProgramStatus(`state=working:title=${b64('a\nb')}`), null);
  assert.equal(parseProgramStatus(`state=working:msg=${b64('a\u0085b')}`), null);
});

test('a title or msg that is not valid base64 or UTF-8 voids the report', () => {
  assert.equal(parseProgramStatus('state=working:msg=***'), null);
  assert.equal(parseProgramStatus(`state=working:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`), null);
});

test('clear parses with and without an id', () => {
  assert.deepEqual(parseProgramStatus('state=clear'), { kind: 'program-status', state: 'clear' });
  assert.deepEqual(parseProgramStatus('state=clear:id=a2b'), { kind: 'program-status', state: 'clear', id: 'a2b' });
});

// --- The probe ---

test('the 7501 probe is detected as a query, not a report', () => {
  assert.deepEqual(parseTerminalEvents('\x1b]7501;?\x1b\\\x1b[c'), [{ kind: 'program-status-query' }]);
  assert.deepEqual(parseTerminalEvents('\x1b]7501;?\x07'), [{ kind: 'program-status-query' }]);
});

test('the probe reply names every state and kind, ST-terminated', () => {
  assert.equal(PROGRAM_STATUS_REPLY,
    '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\');
});

test('7501 sits alongside other sequences in one chunk', () => {
  const chunk = `\x1b]0;◐ Ok\x07${osc7501('state=done:app=claude-code')}\x1b]9;4;0;\x07`;
  assert.deepEqual(parseTerminalEvents(chunk).map(e => e.kind), ['title', 'program-status', 'progress']);
});

// --- Titles ---

test('both the braille and the quarter-circle spinners read busy', () => {
  for (const glyph of ['⠋', '⠙', '◐', '◑', '◒', '◓']) {
    assert.equal(titleMeansBusy(`${glyph} working`), true, glyph);
  }
  assert.equal(titleMeansBusy('✳ Claude Code'), false);
  assert.equal(titleMeansBusy('◔ not a frame'), false);
});

// --- The tracker ---

/** Feed a stream through a fresh tracker and collect what it announced. */
function run(chunks: string[]): { tracker: CliBusyTracker; changes: CliStateChange[] } {
  const tracker = new CliBusyTracker();
  const changes: CliStateChange[] = [];
  for (const chunk of chunks) {
    for (const event of parseTerminalEvents(chunk)) {
      const change = tracker.observe(event);
      if (change) changes.push(change);
    }
  }
  return { tracker, changes };
}

test('a 7501 turn: idle → working → blocked → idle → working → done', () => {
  // The sequence CLI 2.1.301 actually emitted for a denied then retried write.
  const { changes } = run([
    osc7501('state=idle:app=claude-code'),
    osc7501('state=working:app=claude-code'),
    osc7501(`state=working:app=claude-code:msg=${b64('Writing zz-probe.txt')}`),
    osc7501(`state=blocked:app=claude-code:kind=permission:msg=${b64('approve Write: /p')}`),
    osc7501('state=idle:app=claude-code'),
    osc7501('state=working:app=claude-code'),
    osc7501('state=done:app=claude-code'),
  ]);
  assert.deepEqual(changes, [
    { kind: 'busy', busy: true },
    { kind: 'needs-attention' },
    { kind: 'busy', busy: false },
    { kind: 'busy', busy: true },
    { kind: 'busy', busy: false },
  ]);
});

test('error and a root clear both end a turn', () => {
  assert.deepEqual(run([osc7501('state=working'), osc7501('state=error')]).changes,
    [{ kind: 'busy', busy: true }, { kind: 'busy', busy: false }]);
  assert.deepEqual(run([osc7501('state=working'), osc7501('state=clear')]).changes,
    [{ kind: 'busy', busy: true }, { kind: 'busy', busy: false }]);
});

test('a repeated blocked report is announced once; a new prompt again', () => {
  const blocked = (msg: string) => osc7501(`state=blocked:kind=permission:msg=${b64(msg)}`);
  const { changes } = run([blocked('approve A'), blocked('approve A'), blocked('approve B')]);
  assert.deepEqual(changes, [{ kind: 'needs-attention' }, { kind: 'needs-attention' }]);
});

test('child records do not move the session state', () => {
  const { tracker, changes } = run([
    osc7501('state=done'),
    osc7501(`state=working:id=a2b4:title=${b64('Count files')}`),
    osc7501('state=blocked:id=a2b4:kind=question'),
    osc7501('state=clear:id=a2b4'),
  ]);
  assert.deepEqual(changes, []);
  assert.equal(tracker.busy, false);
});

test('once 7501 has spoken, titles and OSC 9;4 no longer drive busy', () => {
  // On 2.1.301 the title keeps "◐ Ok" after the turn; if it still counted, the
  // session would flip back to busy right after 7501 said done.
  const { tracker, changes } = run([
    osc7501('state=idle:app=claude-code'),
    '\x1b]0;◐ Thinking\x07',
    '\x1b]9;4;3;\x07',
  ]);
  assert.deepEqual(changes, []);
  assert.equal(tracker.busy, false);
  assert.equal(tracker.speaksProgramStatus, true);
});

test('a session without 7501 falls back to the title, spinner and all', () => {
  const { changes } = run(['\x1b]0;◐ Thinking\x07', '\x1b]0;◓ Thinking\x07', '\x1b]0;✳ Claude Code\x07']);
  assert.deepEqual(changes, [{ kind: 'busy', busy: true }, { kind: 'busy', busy: false }]);
});

test('without 7501, OSC 9;4 progress starts a turn but its clear does not end one', () => {
  const { tracker, changes } = run(['\x1b]9;4;3;\x07', '\x1b]9;4;0;\x07']);
  assert.deepEqual(changes, [{ kind: 'busy', busy: true }]);
  assert.equal(tracker.busy, true);
});

test('a probe query on its own is not a report and changes nothing', () => {
  const tracker = new CliBusyTracker();
  const query: TerminalEvent = { kind: 'program-status-query' };
  assert.equal(tracker.observe(query), null);
  assert.equal(tracker.speaksProgramStatus, false);
});
