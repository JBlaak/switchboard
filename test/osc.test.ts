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
  /* Given */
  const terminators = ['\x1b\\', '\x07'];

  for (const st of terminators) {
    /* When */
    const events = parseTerminalEvents(osc7501('state=working:app=claude-code', st));

    /* Then */
    assert.deepEqual(events, [
      { kind: 'program-status', state: 'working', app: 'claude-code' },
    ]);
  }
});

test('a blocked report carries its kind as blockedOn and decodes msg', () => {
  /* Given */
  const chunk = osc7501(`state=blocked:app=claude-code:kind=permission:msg=${b64('approve Write: /tmp/zz-probe.txt')}`);

  /* When */
  const events = parseTerminalEvents(chunk);

  /* Then */
  assert.deepEqual(events, [{
    kind: 'program-status', state: 'blocked', app: 'claude-code',
    blockedOn: 'permission', msg: 'approve Write: /tmp/zz-probe.txt',
  }]);
});

test('a child record keeps its id and its decoded UTF-8 title', () => {
  /* Given */
  const chunk = osc7501(`state=working:app=claude-code:id=a2b4e2746e65ed41b:title=${b64('Count files in src/domain — ✓')}`);

  /* When */
  const events = parseTerminalEvents(chunk);

  /* Then */
  assert.deepEqual(events, [{
    kind: 'program-status', state: 'working', app: 'claude-code',
    id: 'a2b4e2746e65ed41b', title: 'Count files in src/domain — ✓',
  }]);
});

test('progress is kept when it is 0–100', () => {
  /* When */
  const report = parseProgramStatus('state=working:progress=42');

  /* Then */
  assert.equal(report?.progress, 42);
});

test('progress is dropped when it is outside 0–100 or not a number', () => {
  /* Given */
  const payloads = ['state=working:progress=101', 'state=working:progress=-1', 'state=working:progress=abc'];

  /* When */
  const progress = payloads.map(p => parseProgramStatus(p)?.progress);

  /* Then */
  assert.deepEqual(progress, [undefined, undefined, undefined]);
});

test('whitespace around pairs is tolerated', () => {
  /* When */
  const report = parseProgramStatus(' state = done : app = claude-code ');

  /* Then */
  assert.deepEqual(report, {
    kind: 'program-status', state: 'done', app: 'claude-code',
  });
});

test('malformed pairs and unknown keys are skipped, not fatal', () => {
  /* When */
  const report = parseProgramStatus('garbage:=nokey:state=idle:future=thing');

  /* Then */
  assert.deepEqual(report, {
    kind: 'program-status', state: 'idle',
  });
});

test('an unknown blocked kind is dropped but the report stands', () => {
  /* When */
  const report = parseProgramStatus('state=blocked:kind=telepathy');

  /* Then */
  assert.deepEqual(report, {
    kind: 'program-status', state: 'blocked',
  });
});

test('a report with no state is ignored', () => {
  /* When */
  const report = parseProgramStatus('app=claude-code');

  /* Then */
  assert.equal(report, null);
});

test('a report with a state this version does not know is ignored', () => {
  /* When */
  const report = parseProgramStatus('state=pondering');
  const events = parseTerminalEvents(osc7501('state=pondering'));

  /* Then */
  assert.equal(report, null);
  assert.deepEqual(events, []);
});

test('a title or msg with control characters voids the report', () => {
  // Decoded text is shown in the UI; an escape smuggled in through base64 must
  // not get there.
  /* Given */
  const payloads = [
    `state=working:msg=${b64('hi\x1b[31m')}`,
    `state=working:title=${b64('a\nb')}`,
    `state=working:msg=${b64('a\u0085b')}`,
  ];

  /* When */
  const reports = payloads.map(p => parseProgramStatus(p));

  /* Then */
  assert.deepEqual(reports, [null, null, null]);
});

test('a title or msg that is not valid base64 voids the report', () => {
  /* When */
  const report = parseProgramStatus('state=working:msg=***');

  /* Then */
  assert.equal(report, null);
});

test('a title or msg that is not valid UTF-8 voids the report', () => {
  /* Given */
  const notUtf8 = Buffer.from([0xff, 0xfe]).toString('base64');

  /* When */
  const report = parseProgramStatus(`state=working:msg=${notUtf8}`);

  /* Then */
  assert.equal(report, null);
});

test('clear parses without an id', () => {
  /* When */
  const report = parseProgramStatus('state=clear');

  /* Then */
  assert.deepEqual(report, { kind: 'program-status', state: 'clear' });
});

test('clear parses with an id', () => {
  /* When */
  const report = parseProgramStatus('state=clear:id=a2b');

  /* Then */
  assert.deepEqual(report, { kind: 'program-status', state: 'clear', id: 'a2b' });
});

// --- The probe ---

test('the 7501 probe is detected as a query, not a report', () => {
  /* Given */
  const probes = ['\x1b]7501;?\x1b\\\x1b[c', '\x1b]7501;?\x07'];

  for (const probe of probes) {
    /* When */
    const events = parseTerminalEvents(probe);

    /* Then */
    assert.deepEqual(events, [{ kind: 'program-status-query' }]);
  }
});

test('the probe reply names every state and kind, ST-terminated', () => {
  /* Then */
  assert.equal(PROGRAM_STATUS_REPLY,
    '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\');
});

test('7501 sits alongside other sequences in one chunk', () => {
  /* Given */
  const chunk = `\x1b]0;◐ Ok\x07${osc7501('state=done:app=claude-code')}\x1b]9;4;0;\x07`;

  /* When */
  const events = parseTerminalEvents(chunk);

  /* Then */
  assert.deepEqual(events.map(e => e.kind), ['title', 'program-status', 'progress']);
});

// --- Titles ---

test('both the braille and the quarter-circle spinners read busy', () => {
  /* Given */
  const glyphs = ['⠋', '⠙', '◐', '◑', '◒', '◓'];

  for (const glyph of glyphs) {
    /* When */
    const busy = titleMeansBusy(`${glyph} working`);

    /* Then */
    assert.equal(busy, true, glyph);
  }
});

test('the idle mark and a glyph that is not a spinner frame do not read busy', () => {
  /* When */
  const idle = titleMeansBusy('✳ Claude Code');
  const notAFrame = titleMeansBusy('◔ not a frame');

  /* Then */
  assert.equal(idle, false);
  assert.equal(notAFrame, false);
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
  /* Given */
  // The sequence CLI 2.1.301 actually emitted for a denied then retried write.
  const chunks = [
    osc7501('state=idle:app=claude-code'),
    osc7501('state=working:app=claude-code'),
    osc7501(`state=working:app=claude-code:msg=${b64('Writing zz-probe.txt')}`),
    osc7501(`state=blocked:app=claude-code:kind=permission:msg=${b64('approve Write: /p')}`),
    osc7501('state=idle:app=claude-code'),
    osc7501('state=working:app=claude-code'),
    osc7501('state=done:app=claude-code'),
  ];

  /* When */
  const { changes } = run(chunks);

  /* Then */
  assert.deepEqual(changes, [
    { kind: 'ready' },
    { kind: 'busy', busy: true },
    { kind: 'needs-attention' },
    { kind: 'busy', busy: false },
    { kind: 'busy', busy: true },
    { kind: 'busy', busy: false },
  ]);
});

test('error ends a turn', () => {
  /* When */
  const { changes } = run([osc7501('state=working'), osc7501('state=error')]);

  /* Then */
  assert.deepEqual(changes, [{ kind: 'busy', busy: true }, { kind: 'busy', busy: false }]);
});

test('a root clear ends a turn', () => {
  /* When */
  const { changes } = run([osc7501('state=working'), osc7501('state=clear')]);

  /* Then */
  assert.deepEqual(changes, [{ kind: 'busy', busy: true }, { kind: 'busy', busy: false }]);
});

test('a repeated blocked report is announced once; a new prompt again', () => {
  /* Given */
  const blocked = (msg: string) => osc7501(`state=blocked:kind=permission:msg=${b64(msg)}`);

  /* When */
  const { changes } = run([blocked('approve A'), blocked('approve A'), blocked('approve B')]);

  /* Then */
  assert.deepEqual(changes, [{ kind: 'needs-attention' }, { kind: 'needs-attention' }]);
});

test('child records do not move the session state', () => {
  /* Given */
  const chunks = [
    osc7501('state=done'),
    osc7501(`state=working:id=a2b4:title=${b64('Count files')}`),
    osc7501('state=blocked:id=a2b4:kind=question'),
    osc7501('state=clear:id=a2b4'),
  ];

  /* When */
  const { tracker, changes } = run(chunks);

  /* Then */
  assert.deepEqual(changes, [{ kind: 'ready' }], 'the root said done: at its prompt, nothing else');
  assert.equal(tracker.busy, false);
});

test('once 7501 has spoken, titles and OSC 9;4 no longer drive busy', () => {
  /* Given */
  // On 2.1.301 the title keeps "◐ Ok" after the turn; if it still counted, the
  // session would flip back to busy right after 7501 said done.
  const chunks = [
    osc7501('state=idle:app=claude-code'),
    '\x1b]0;◐ Thinking\x07',
    '\x1b]9;4;3;\x07',
  ];

  /* When */
  const { tracker, changes } = run(chunks);

  /* Then */
  assert.deepEqual(changes, [{ kind: 'ready' }]);
  assert.equal(tracker.busy, false);
  assert.equal(tracker.speaksProgramStatus, true);
});

test('ready: a fresh session is not ready', () => {
  // A fresh session: not busy, but not ready for a prompt either until it shows one.
  /* When */
  const tracker = new CliBusyTracker();

  /* Then */
  assert.equal(tracker.ready, false);
});

test('ready: said once, the first time the CLI is at its prompt without a turn before it', () => {
  /* When */
  const viaTitle = run(['\x1b]0;✳ Claude Code\x07', '\x1b]0;✳ Claude Code\x07']);

  /* Then */
  assert.deepEqual(viaTitle.changes, [{ kind: 'ready' }]);
  assert.equal(viaTitle.tracker.ready, true);
});

test('ready: a turn that starts before the first prompt makes it ready when it ends', () => {
  // A turn that starts before the first prompt: its end is the idle, and makes it ready.
  /* When */
  const turnFirst = run([osc7501('state=working'), osc7501('state=idle'), osc7501('state=idle')]);

  /* Then */
  assert.deepEqual(turnFirst.changes, [{ kind: 'busy', busy: true }, { kind: 'busy', busy: false }]);
  assert.equal(turnFirst.tracker.ready, true);
});

test('ready: blocked is not a prompt that takes input', () => {
  /* When */
  const blocked = run([osc7501('state=blocked:kind=permission')]);

  /* Then */
  assert.equal(blocked.tracker.ready, false);
});

test('a session without 7501 falls back to the title, spinner and all', () => {
  /* When */
  const { changes } = run(['\x1b]0;◐ Thinking\x07', '\x1b]0;◓ Thinking\x07', '\x1b]0;✳ Claude Code\x07']);

  /* Then */
  assert.deepEqual(changes, [{ kind: 'busy', busy: true }, { kind: 'busy', busy: false }]);
});

test('without 7501, OSC 9;4 progress starts a turn but its clear does not end one', () => {
  /* When */
  const { tracker, changes } = run(['\x1b]9;4;3;\x07', '\x1b]9;4;0;\x07']);

  /* Then */
  assert.deepEqual(changes, [{ kind: 'busy', busy: true }]);
  assert.equal(tracker.busy, true);
});

test('a probe query on its own is not a report and changes nothing', () => {
  /* Given */
  const tracker = new CliBusyTracker();
  const query: TerminalEvent = { kind: 'program-status-query' };

  /* When */
  const change = tracker.observe(query);

  /* Then */
  assert.equal(change, null);
  assert.equal(tracker.speaksProgramStatus, false);
});
