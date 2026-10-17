import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/renderer/state/app-store';
import { openSessions } from '../src/renderer/state/session-store';
import {
  ESC_SYNC_END, ESC_SYNC_START, bufferTerminalData,
} from '../src/renderer/features/terminal/write-buffer';
import type { OpenSession } from '../src/renderer/state/session-store';

// The registries are module singletons shared by every test here, so each test
// uses an id of its own.

/** Frames run when the test says so, not on a clock. */
let frames: (() => void)[] = [];
Object.assign(globalThis, {
  requestAnimationFrame: (cb: () => void) => frames.push(cb),
  cancelAnimationFrame: (id: number) => { if (id) frames[id - 1] = () => {}; },
});
function runFrames(): void {
  const due = frames;
  frames = [];
  due.forEach(frame => frame());
}

interface FakeTerminal {
  /** Each write, as one string. */
  written: string[];
  scrolledToBottom: number;
  /** Each `scrollLines` amount. */
  scrolledBy: number[];
}

/**
 * An open terminal whose viewport sits at `viewportY` of `baseY`; each write
 * adds `grows` lines of scrollback, moving the viewport along as xterm does
 * when a write lands while the user is reading further up.
 */
function open(sessionId: string, at: { viewportY: number; baseY: number; grows?: number } = { viewportY: 0, baseY: 0 }): FakeTerminal {
  const fake: FakeTerminal = { written: [], scrolledToBottom: 0, scrolledBy: [] };
  const active = { viewportY: at.viewportY, baseY: at.baseY };
  const terminal = {
    write: (data: string, done?: () => void) => {
      fake.written.push(data);
      active.baseY += at.grows ?? 0;
      active.viewportY += at.grows ?? 0;
      done?.();
    },
    buffer: { active },
    scrollToBottom: () => { fake.scrolledToBottom++; },
    scrollLines: (amount: number) => { fake.scrolledBy.push(amount); },
  };
  openSessions.set(sessionId, { terminal } as unknown as OpenSession);
  return fake;
}

test('output outside a synchronized update is written once per frame', () => {
  /* Given */
  const terminal = open('w-plain');
  bufferTerminalData('w-plain', 'one ');
  bufferTerminalData('w-plain', 'two');

  /* When */
  runFrames();

  /* Then */
  assert.deepEqual(terminal.written, ['one two']);
});

test('a synchronized update writes nothing while it is open', () => {
  /* Given */
  const terminal = open('w-open');

  /* When */
  bufferTerminalData('w-open', ESC_SYNC_START + 'part one');
  runFrames();

  /* Then */
  assert.deepEqual(terminal.written, []);
});

test('a synchronized update is written whole when it ends', () => {
  /* Given */
  const terminal = open('w-sync');
  bufferTerminalData('w-sync', ESC_SYNC_START + 'part one');
  runFrames();

  /* When */
  bufferTerminalData('w-sync', 'part two' + ESC_SYNC_END);
  runFrames();

  /* Then */
  assert.deepEqual(terminal.written, [ESC_SYNC_START + 'part one' + 'part two' + ESC_SYNC_END]);
});

/** Open an outer update, and an inner one inside it. */
function nested(sessionId: string): FakeTerminal {
  const terminal = open(sessionId);
  bufferTerminalData(sessionId, ESC_SYNC_START + 'outer');
  bufferTerminalData(sessionId, ESC_SYNC_START + 'inner');
  return terminal;
}

test('the inner of nested synchronized updates ending does not release them', () => {
  /* Given */
  const terminal = nested('w-inner');

  /* When */
  bufferTerminalData('w-inner', ESC_SYNC_END);
  runFrames();

  /* Then */
  assert.deepEqual(terminal.written, []);
});

test('nested synchronized updates are written when the outer one ends', () => {
  /* Given */
  const terminal = nested('w-outer');
  bufferTerminalData('w-outer', ESC_SYNC_END);
  runFrames();

  /* When */
  bufferTerminalData('w-outer', ESC_SYNC_END);
  runFrames();

  /* Then */
  assert.equal(terminal.written.length, 1);
  assert.ok(terminal.written[0].includes('outer'));
  assert.ok(terminal.written[0].includes('inner'));
});

test('an unclosed synchronized update is still held just short of 500ms', (t) => {
  /* Given */
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const terminal = open('w-held');
  bufferTerminalData('w-held', ESC_SYNC_START + 'never closed');

  /* When */
  t.mock.timers.tick(499);

  /* Then */
  assert.deepEqual(terminal.written, []);
});

test('an unclosed synchronized update is written after 500ms', (t) => {
  /* Given */
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const terminal = open('w-unclosed');
  bufferTerminalData('w-unclosed', ESC_SYNC_START + 'never closed');

  /* When */
  t.mock.timers.tick(500);

  /* Then */
  assert.deepEqual(terminal.written, [ESC_SYNC_START + 'never closed']);
});

test('output keeps the terminal on screen pinned to the bottom', () => {
  /* Given */
  const terminal = open('w-bottom', { viewportY: 50, baseY: 50 });
  dispatch({ type: 'activeSessionChanged', sessionId: 'w-bottom' });

  /* When */
  bufferTerminalData('w-bottom', 'more');
  runFrames();

  /* Then */
  assert.equal(terminal.scrolledToBottom, 1);
  assert.deepEqual(terminal.scrolledBy, []);
});

test('output leaves a scrolled-up terminal where it was', () => {
  /* Given */
  const terminal = open('w-up', { viewportY: 20, baseY: 50, grows: 3 });
  dispatch({ type: 'activeSessionChanged', sessionId: 'w-up' });

  /* When */
  bufferTerminalData('w-up', 'more');
  runFrames();

  /* Then */
  // The write moved the viewport 3 lines on; it is put back.
  assert.equal(terminal.scrolledToBottom, 0);
  assert.deepEqual(terminal.scrolledBy, [-3]);
});

test('output for a terminal off screen does not scroll it', () => {
  /* Given */
  const terminal = open('w-hidden', { viewportY: 50, baseY: 50 });
  dispatch({ type: 'activeSessionChanged', sessionId: 'w-elsewhere' });

  /* When */
  bufferTerminalData('w-hidden', 'more');
  runFrames();

  /* Then */
  assert.deepEqual(terminal.written, ['more']);
  assert.equal(terminal.scrolledToBottom, 0);
  assert.deepEqual(terminal.scrolledBy, []);
});
