import { test, mock } from 'node:test';
import assert from 'node:assert';
import { rekeyRegistries } from '../src/renderer/app/rekey-registries';
import { dispatch, getState } from '../src/renderer/state/app-store';
import {
  injectIntoCaches, openSessions, pendingSessions, sessionMap, view,
} from '../src/renderer/state/session-store';
import { STORAGE_KEYS } from '../src/renderer/state/storage';
import {
  ESC_SYNC_START, SYNC_BUFFER_TIMEOUT, bufferTerminalData, terminalWriteBuffers,
} from '../src/renderer/features/terminal/write-buffer';
import type { OpenSession } from '../src/renderer/state/session-store';
import type { SessionRow } from '../src/domain/session/session';

// The registries are module singletons shared by every test here, so each test
// uses ids of its own.

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

const stored = new Map<string, string>();
Object.assign(globalThis, {
  sessionStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  },
});

/** A launched session: a row in the caches, a pending entry and an open terminal, all one object. */
function launch(sessionId: string) {
  const row = { sessionId, projectPath: '/p', summary: 'hello', modified: new Date().toISOString() } as SessionRow;
  pendingSessions.set(sessionId, { session: row, projectPath: '/p', folder: '-p' });
  injectIntoCaches(row, '-p');
  const written: string[] = [];
  const entry = {
    session: row,
    terminal: {
      write: (data: string, done?: () => void) => { written.push(data); done?.(); },
      buffer: { active: { viewportY: 0, baseY: 0 } },
      scrollToBottom: () => {},
      scrollLines: () => {},
    },
  } as unknown as OpenSession;
  openSessions.set(sessionId, entry);
  return { row, entry, written };
}

/** Play the reducer's half of the re-key, as the store does before the follow-up runs. */
function forked(oldId: string, newId: string) {
  dispatch({ type: 'sessionForked', oldId, newId });
  rekeyRegistries(oldId, newId, getState());
}

test('a re-key moves every registry to the new id and leaves nothing under the old one', () => {
  /* Given */
  const { row, entry } = launch('r-old');
  dispatch({ type: 'activeSessionChanged', sessionId: 'r-old' });
  bufferTerminalData('r-old', 'held');

  /* When */
  forked('r-old', 'r-new');

  /* Then */
  for (const registry of [openSessions, pendingSessions, sessionMap, terminalWriteBuffers]) {
    assert.ok(!registry.has('r-old'));
    assert.ok(registry.has('r-new'));
  }
  assert.strictEqual(openSessions.get('r-new'), entry);
  assert.strictEqual(sessionMap.get('r-new'), row);
  assert.strictEqual(pendingSessions.get('r-new')!.session, row);
  // The cached project lists hold the same object, so they follow too.
  assert.strictEqual(row.sessionId, 'r-new');
  assert.ok(view.cachedProjects.some(p => p.sessions.includes(row)));
  assert.strictEqual(stored.get(STORAGE_KEYS.activeSessionId), 'r-new');
});

test('output held under the old id is still written after the re-key', () => {
  /* Given */
  const { written } = launch('w-old');
  bufferTerminalData('w-old', 'a');
  bufferTerminalData('w-old', 'b');

  /* When */
  forked('w-old', 'w-new');
  runFrames();

  /* Then */
  assert.deepStrictEqual(written, ['ab']);
  assert.ok(!terminalWriteBuffers.has('w-new'));
});

test('an open synchronised block still times out after the re-key', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    /* Given */
    const { written } = launch('t-old');
    bufferTerminalData('t-old', ESC_SYNC_START + 'half a repaint');

    /* When */
    forked('t-old', 't-new');
    runFrames();

    /* Then */
    assert.deepStrictEqual(written, [], 'held while the block is open');

    /* When */
    mock.timers.tick(SYNC_BUFFER_TIMEOUT);

    /* Then */
    assert.deepStrictEqual(written, [ESC_SYNC_START + 'half a repaint']);
  } finally {
    mock.timers.reset();
  }
});

test('the row keeps its local key across the re-key', () => {
  /* Given */
  launch('k-old');
  const key = getState().keys.byId['k-old'];

  /* When */
  forked('k-old', 'k-new');

  /* Then */
  assert.ok(key);
  assert.strictEqual(getState().keys.byId['k-new'], key);
});

test('a session on screen elsewhere is not persisted as the one on screen', () => {
  /* Given */
  launch('bg-old');
  dispatch({ type: 'activeSessionChanged', sessionId: 'someone-else' });
  stored.delete(STORAGE_KEYS.activeSessionId);

  /* When */
  forked('bg-old', 'bg-new');

  /* Then */
  assert.strictEqual(stored.get(STORAGE_KEYS.activeSessionId), undefined);
});
