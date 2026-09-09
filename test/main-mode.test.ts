import { test } from 'node:test';
import assert from 'node:assert';
import {
  MAIN_MODES,
  flipped, foldedHalf, lastMessageLine, modeStorageKey, parseMainMode,
  readSessionMode, surfacesFor, writeSessionMode,
} from '../src/renderer/app/main-mode-model';
import type { MainMode } from '../src/renderer/app/main-mode-model';

/**
 * The flip's rules, exercised without a DOM.
 *
 * `main-mode-model.ts` is deliberately the only part of the flip with decisions
 * in it — `main-mode.ts` moves elements and refits terminals — and it imports
 * nothing that touches `document`, which is what lets this file import it at
 * all. The renderer has no jsdom harness and does not want one.
 */

/** Web Storage, as `readStored`/`writeStored` reach for it. */
function fakeStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (i: number) => [...entries.keys()][i] ?? null,
    removeItem: (key: string) => { entries.delete(key); },
    setItem: (key: string, value: string) => { entries.set(key, value); },
  } as Storage;
}

function withStorage(): Storage {
  const store = fakeStorage();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = store;
  return store;
}

// ── the table: which surfaces each mode wants ─────────────────────────────────

test('talk is the conversation alone', () => {
  assert.deepStrictEqual(surfacesFor('talk'), {
    terminal: true, filePanel: false, code: false,
  });
});

test('split is talk with the panel out — the same terminal, one more column', () => {
  assert.deepStrictEqual(surfacesFor('split'), {
    terminal: true, filePanel: true, code: false,
  });
});

test('code is the only mode that takes the terminal off screen', () => {
  assert.deepStrictEqual(surfacesFor('code'), {
    terminal: false, filePanel: false, code: true,
  });
  // And it never leaves the split open behind it: the panel lives inside the
  // area that has just been hidden, so an open panel there would be a column of
  // state nobody can see or close.
  assert.strictEqual(surfacesFor('code').filePanel, false);
});

test('the code area and the terminal area are never both up', () => {
  for (const mode of MAIN_MODES) {
    const surfaces = surfacesFor(mode);
    assert.ok(!(surfaces.terminal && surfaces.code), `${mode} shows both halves full width`);
    assert.ok(surfaces.terminal || surfaces.code, `${mode} shows neither half`);
  }
});

test('the split only ever opens inside the terminal area', () => {
  for (const mode of MAIN_MODES) {
    const surfaces = surfacesFor(mode);
    if (surfaces.filePanel) assert.strictEqual(surfaces.terminal, true, mode);
  }
});

// ── ⌘J from each of the three ─────────────────────────────────────────────────

test('the gesture bounces the outer two', () => {
  assert.strictEqual(flipped('talk'), 'code');
  assert.strictEqual(flipped('code'), 'talk');
});

test('from split it goes to code, and comes back to talk', () => {
  // Both halves are already on screen, so the useful next thing is the one the
  // split cannot give: the code side with the whole window.
  assert.strictEqual(flipped('split'), 'code');
  // And the way back is talk. A gesture that remembered split would be one
  // nobody could predict; the user picked split explicitly and can pick it again.
  assert.strictEqual(flipped(flipped('split')), 'talk');
});

test('two flips from an outer mode are a no-op', () => {
  assert.strictEqual(flipped(flipped('talk')), 'talk');
  assert.strictEqual(flipped(flipped('code')), 'code');
});

// ── which half is folded ──────────────────────────────────────────────────────

test('the half you are not in is the one that folds', () => {
  assert.strictEqual(foldedHalf('talk'), 'code');
  assert.strictEqual(foldedHalf('code'), 'conversation');
});

test('split folds neither — both halves are already on screen', () => {
  assert.strictEqual(foldedHalf('split'), null);
});

test('the folded half is always the surface the mode does not show', () => {
  for (const mode of MAIN_MODES) {
    const folded = foldedHalf(mode);
    if (folded === 'code') assert.strictEqual(surfacesFor(mode).code, false);
    if (folded === 'conversation') assert.strictEqual(surfacesFor(mode).terminal, false);
  }
});

// ── reading a stored mode ─────────────────────────────────────────────────────

test('the three modes survive a round trip', () => {
  for (const mode of MAIN_MODES) assert.strictEqual(parseMainMode(mode), mode);
});

test('an unknown stored value falls back to talk', () => {
  // A hand-edited value, the spelling some later build uses, or a key that was
  // never written. None of them is worth breaking the flip over.
  assert.strictEqual(parseMainMode(null), 'talk');
  assert.strictEqual(parseMainMode(undefined), 'talk');
  assert.strictEqual(parseMainMode(''), 'talk');
  assert.strictEqual(parseMainMode('diff'), 'talk');
  assert.strictEqual(parseMainMode('Code'), 'talk');
  assert.strictEqual(parseMainMode('{"mode":"code"}'), 'talk');
});

// ── per-session persistence and restore ───────────────────────────────────────

test('a session with nothing stored starts in talk', () => {
  withStorage();
  assert.strictEqual(readSessionMode('abc'), 'talk');
});

test('each session remembers its own half', () => {
  withStorage();
  writeSessionMode('reading', 'code');
  writeSessionMode('pairing', 'split');

  // The whole point of keying by session: the one you were reading stays on
  // code while the one you switch to stays where you left it.
  assert.strictEqual(readSessionMode('reading'), 'code');
  assert.strictEqual(readSessionMode('pairing'), 'split');
  assert.strictEqual(readSessionMode('untouched'), 'talk');
});

test('a session flipped back to talk forgets the entry rather than writing it', () => {
  const store = withStorage();
  writeSessionMode('s1', 'code');
  assert.strictEqual(store.getItem(modeStorageKey('s1')), 'code');

  writeSessionMode('s1', 'talk');
  // Absent and 'talk' are the same answer, so there is nothing to keep.
  assert.strictEqual(store.getItem(modeStorageKey('s1')), null);
  assert.strictEqual(readSessionMode('s1'), 'talk');
});

test('the keys are per session and namespaced', () => {
  assert.notStrictEqual(modeStorageKey('a'), modeStorageKey('b'));
  assert.ok(modeStorageKey('a').startsWith('mainMode'));
});

test('a stored value nothing recognises restores as talk', () => {
  const store = withStorage();
  store.setItem(modeStorageKey('s1'), 'whole-diff');
  assert.strictEqual(readSessionMode('s1'), 'talk');
});

test('no Web Storage at all is not an error', () => {
  // A browser with site data blocked throws on the property access itself, and
  // the flip has to keep working — unremembered, but working.
  const globals = globalThis as { sessionStorage?: Storage };
  const saved = globals.sessionStorage;
  delete globals.sessionStorage;
  try {
    assert.strictEqual(readSessionMode('s1'), 'talk');
    assert.doesNotThrow(() => writeSessionMode('s1', 'code'));
  } finally {
    globals.sessionStorage = saved;
  }
});

// ── the line the folded conversation quotes ───────────────────────────────────

test('the newest line with something on it wins', () => {
  assert.strictEqual(
    lastMessageLine(['● Reading the diff', '● Both worktrees are on the rail now.']),
    '● Both worktrees are on the rail now.',
  );
});

test('the CLI input box is not the last thing said', () => {
  // The prompt is repainted constantly and is always the newest row, which is
  // exactly why the newest row is the wrong answer.
  assert.strictEqual(
    lastMessageLine([
      '● Added a scopedProjectPath flag so the label renders once.',
      '',
      '╭──────────────────────────────────────╮',
      '│ >                                    │',
      '╰──────────────────────────────────────╯',
      '',
    ]),
    '● Added a scopedProjectPath flag so the label renders once.',
  );
});

test('a terminal that has only ever shown a prompt has no last message', () => {
  assert.strictEqual(lastMessageLine([]), '');
  assert.strictEqual(lastMessageLine(['', '   ', '›']), '');
});

test('runs of whitespace collapse, so an indented line still reads as one', () => {
  assert.strictEqual(
    lastMessageLine(['  └   Added 12 lines,   removed 4 lines  ']),
    '└ Added 12 lines, removed 4 lines',
  );
});

test('a very long line is cut rather than left to reflow the strip', () => {
  const line = lastMessageLine(['x'.repeat(500)]);
  assert.ok(line.length <= 200, `kept ${line.length} characters`);
  assert.ok(line.endsWith('…'));
});

// ── the control's order ───────────────────────────────────────────────────────

test('the segmented control reads Talk | Split | Code', () => {
  // Left to right is conversation → both → code, so the two ⌘J bounces between
  // are the two ends and the one it will not stop on is in the middle.
  assert.deepStrictEqual([...MAIN_MODES], ['talk', 'split', 'code'] as MainMode[]);
});
