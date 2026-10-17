import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { diffKey, imageKeyEvent, storedImageDefaults } from '../src/renderer/state/session-work-slice';
import { dispatch, getState } from '../src/renderer/state/app-store';
import { STORAGE_KEYS } from '../src/renderer/state/storage';
import { installImageDefaults } from '../src/renderer/ui/session-work/image-defaults';
import { imageCollapsedText } from '../src/renderer/ui/session-work/describe';
import { IMAGE_AUTO_LOAD_BYTES } from '../src/domain/session-work/image';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { View } from '../src/renderer/ui/session-work/image-compare/types';
import type { FileDiff, SessionWorkItem, SessionWorkSnapshot } from '../src/domain/session-work/model';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const branch: SessionWorkItem = {
  id: 'branch:/w\0art',
  kind: 'branch',
  location: { worktree: '/w', branch: 'art', fromSubagent: false },
  ahead: 1,
  diff: { kind: 'local', worktree: '/w', base: 'origin/main', head: 'art' },
  activity: null,
  additions: 0,
  deletions: 0,
  pushed: false,
};
const ID = branch.id;

const changed: FileDiff = {
  path: 'logo.png', status: 'modified', additions: 0, deletions: 0, hunks: [], binary: true,
  image: { format: 'png', before: { bytes: 100 }, after: { bytes: 120 } },
};
const added: FileDiff = {
  path: 'icon.png', status: 'added', additions: 0, deletions: 0, hunks: [], binary: true,
  image: { format: 'png', before: null, after: { bytes: 80 } },
};
const code: FileDiff = { path: 'a.ts', status: 'modified', additions: 1, deletions: 1, hunks: [], binary: false };

function snapshot(): SessionWorkSnapshot {
  return { sessionId: 's1', repository: 'acme/art', items: [branch], footprint: { worktrees: 1, branches: 1 }, queued: 0, gh: 'ok', updatedAt: '2026-06-10T14:00:00.000Z' };
}

/** The page open on the branch, its diff of a changed image, an added one and a code file shown. */
function shown(): RendererState {
  const key = diffKey(branch);
  return run(initialRendererState('s1'),
    { type: 'sessionWorkOpened', sessionId: 's1', name: 'Art', at: 0 },
    { type: 'sessionWorkSnapshot', snapshot: snapshot() },
    { type: 'sessionWorkDiffRequested', sessionId: 's1', itemId: ID, key },
    { type: 'sessionWorkDiffLoaded', sessionId: 's1', itemId: ID, key, diff: { files: [changed, added, code], source: 'local' } });
}

const page = (state: RendererState) => state.sessionWork.page!;
const card = (state: RendererState, path = changed.path) => page(state).diffs[ID].images[path];
const FIT: View = { scale: 0.5, x: 10, y: 0 };
const WIDER_FIT: View = { scale: 0.8, x: 20, y: 0 };
const ZOOMED: View = { scale: 2, x: -40, y: -10 };
const framed = (fit: View, path = changed.path): RendererEvent => ({ type: 'sessionWorkImageFramed', itemId: ID, path, fit });
const focused = (path: string): RendererEvent => ({ type: 'sessionWorkFileFocused', itemId: ID, path });

// ── Defaults ──

test('image defaults: nothing saved opens side-by-side on a checkerboard', () => {
  /* Given */
  const saved = { mode: null, background: null };

  /* When */
  const defaults = storedImageDefaults(saved.mode, saved.background);

  /* Then */
  assert.deepEqual(defaults, { mode: 'side-by-side', background: 'checkerboard' });
});

test('image defaults: what was saved comes back, and an unknown value falls back on its own', () => {
  /* Given */
  const saved = [['swipe', 'dark'], ['zoom', 'light'], ['pixel-diff', 'purple']] as const;

  /* When */
  const defaults = saved.map(([mode, background]) => storedImageDefaults(mode, background));

  /* Then */
  assert.deepEqual(defaults, [
    { mode: 'swipe', background: 'dark' },
    { mode: 'side-by-side', background: 'light' },
    { mode: 'pixel-diff', background: 'checkerboard' },
  ]);
});

let stopDefaults: (() => void) | null = null;
afterEach(() => {
  stopDefaults?.();
  stopDefaults = null;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function fakeLocalStorage(initial: Record<string, string>): Map<string, string> {
  const items = new Map(Object.entries(initial));
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
    },
  });
  return items;
}

test('image defaults: read from localStorage when the page is installed, and written back as they change', () => {
  /* Given */
  const items = fakeLocalStorage({ [STORAGE_KEYS.imageCompareMode]: 'onion', [STORAGE_KEYS.imageCompareBackground]: 'light' });

  /* When */
  stopDefaults = installImageDefaults();

  /* Then */
  assert.deepEqual(getState().sessionWork.imageDefaults, { mode: 'onion', background: 'light' });

  /* When */
  dispatch({ type: 'sessionWorkImageModeSet', itemId: 'none', path: 'none', mode: 'blink' });
  dispatch({ type: 'sessionWorkImageBackgroundSet', background: 'dark' });

  /* Then */
  assert.equal(items.get(STORAGE_KEYS.imageCompareMode), 'blink');
  assert.equal(items.get(STORAGE_KEYS.imageCompareBackground), 'dark');
});

// ── A card's state ──

test('image card: none until its stage reports a frame, then it opens fitted in the default mode', () => {
  /* Given */
  const state = run(shown(), { type: 'sessionWorkImageModeSet', itemId: 'other', path: 'x.png', mode: 'onion' });
  assert.equal(card(state), undefined);

  /* When */
  const next = run(state, framed(FIT));

  /* Then */
  assert.deepEqual(card(next), { mode: 'onion', view: FIT, fit: FIT, fitted: true, blink: 'before' });
});

test('image card: a new frame refits a card the user has not moved', () => {
  /* Given */
  const state = run(shown(), framed(FIT));

  /* When */
  const next = run(state, framed(WIDER_FIT));

  /* Then */
  assert.deepEqual(card(next).view, WIDER_FIT);
  assert.equal(card(next).fitted, true);
});

test('image card: once zoomed, a new frame leaves the view, and 0 fits it to the latest frame', () => {
  /* Given */
  const state = run(shown(), framed(FIT), { type: 'sessionWorkImageViewed', itemId: ID, path: changed.path, view: ZOOMED });

  /* When */
  const next = run(state, framed(WIDER_FIT));

  /* Then */
  assert.deepEqual(card(next).view, ZOOMED, 'kept');
  assert.equal(card(next).fitted, false);

  /* When */
  const fitted = run(next, { type: 'sessionWorkImageFitted', itemId: ID, path: changed.path });

  /* Then */
  assert.deepEqual(card(fitted).view, WIDER_FIT);
  assert.equal(card(fitted).fitted, true);
});

test('image card: the same frame measured again changes nothing', () => {
  /* Given */
  const state = run(shown(), framed(FIT));

  /* When */
  const next = run(state, framed({ ...FIT, x: FIT.x + 0.1 }));

  /* Then */
  assert.equal(next.sessionWork, state.sessionWork);
});

test('image card: a mode picked is that card\'s and every new card\'s, but not a card already drawn', () => {
  /* Given */
  const state = run(shown(), framed(FIT), framed(FIT, added.path));

  /* When */
  const next = run(state, { type: 'sessionWorkImageModeSet', itemId: ID, path: changed.path, mode: 'swipe' });

  /* Then */
  assert.equal(card(next).mode, 'swipe');
  assert.equal(card(next, added.path).mode, 'side-by-side', 'drawn before the pick');
  assert.equal(next.sessionWork.imageDefaults.mode, 'swipe');
});

test('image card: blink flips between before and after', () => {
  /* Given */
  const state = run(shown(), framed(FIT));
  const blinked: RendererEvent = { type: 'sessionWorkImageBlinked', itemId: ID, path: changed.path };

  /* When */
  const once = run(state, blinked);
  const twice = run(once, blinked);

  /* Then */
  assert.equal(card(once).blink, 'after');
  assert.equal(card(twice).blink, 'before');
});

test('image card: the background is the page\'s, for every card', () => {
  /* Given */
  const state = shown();

  /* When */
  const next = run(state, { type: 'sessionWorkImageBackgroundSet', background: 'dark' });

  /* Then */
  assert.equal(next.sessionWork.imageDefaults.background, 'dark');
});

test('image card: a diff loaded again keeps the cards drawn', () => {
  /* Given */
  const state = run(shown(), framed(FIT));
  const key = diffKey(branch) + '!';

  /* When */
  const next = run(state,
    { type: 'sessionWorkDiffRequested', sessionId: 's1', itemId: ID, key },
    { type: 'sessionWorkDiffLoaded', sessionId: 's1', itemId: ID, key, diff: { files: [changed], source: 'local' } });

  /* Then */
  assert.deepEqual(card(next).view, FIT);
});

// ── Keys (C6) ──

test('image keys: nothing before n or p has landed on a card', () => {
  /* Given */
  const state = shown();

  /* When */
  const event = imageKeyEvent(page(state), '2');

  /* Then */
  assert.equal(event, null);
});

test('image keys: 1–5 pick the focused card\'s mode, b flips blink and 0 fits it', () => {
  /* Given */
  const state = run(shown(), focused(changed.path));

  /* When */
  const keys = ['1', '2', '3', '4', '5', 'b', '0', '6'].map(key => imageKeyEvent(page(state), key));

  /* Then */
  const path = changed.path;
  assert.deepEqual(keys, [
    { type: 'sessionWorkImageModeSet', itemId: ID, path, mode: 'side-by-side' },
    { type: 'sessionWorkImageModeSet', itemId: ID, path, mode: 'swipe' },
    { type: 'sessionWorkImageModeSet', itemId: ID, path, mode: 'onion' },
    { type: 'sessionWorkImageModeSet', itemId: ID, path, mode: 'blink' },
    { type: 'sessionWorkImageModeSet', itemId: ID, path, mode: 'pixel-diff' },
    { type: 'sessionWorkImageBlinked', itemId: ID, path },
    { type: 'sessionWorkImageFitted', itemId: ID, path },
    null,
  ]);
});

test('image keys: an image with one side takes only 1 and 0', () => {
  /* Given */
  const state = run(shown(), focused(added.path));

  /* When */
  const keys = ['1', '2', 'b', '0'].map(key => imageKeyEvent(page(state), key)?.type ?? null);

  /* Then */
  assert.deepEqual(keys, ['sessionWorkImageModeSet', null, null, 'sessionWorkImageFitted']);
});

test('image keys: a focused file that is not an image takes none', () => {
  /* Given */
  const state = run(shown(), focused(code.path));

  /* When */
  const keys = ['1', 'b', '0'].map(key => imageKeyEvent(page(state), key));

  /* Then */
  assert.deepEqual(keys, [null, null, null]);
});

// ── Loading (L1) ──

test('image card: loads by itself up to the limit, and over it starts collapsed with the size', () => {
  /* Given */
  const small = { format: 'png' as const, before: { bytes: IMAGE_AUTO_LOAD_BYTES }, after: null };
  const big = { format: 'png' as const, before: { bytes: 10 }, after: { bytes: 12 * 1024 * 1024 } };

  /* When */
  const reasons = [imageCollapsedText(small), imageCollapsedText(big)];

  /* Then */
  assert.deepEqual(reasons, [null, 'Large image · 12 MB']);
});
