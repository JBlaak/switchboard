/**
 * The Quick Ask pop-up's keys (B3), whether the pointer is over the slab
 * (G3), and where the window goes on a display (B2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overSlab, quickAskKey } from '../src/renderer/quick-ask/quick-ask-keys';
import { QUICK_ASK_SIZE, SLAB_TOP, quickAskBounds } from '../src/infrastructure/electron/quick-ask-bounds';

const press = (key: string, shiftKey = false, isComposing = false) => ({ key, shiftKey, isComposing });

// ── Keys ──

test('editing: Enter sends, Shift+Enter is a new line, Esc closes', () => {
  /* When */
  const actions = [press('Enter'), press('Enter', true), press('Escape'), press('a')]
    .map(key => quickAskKey('editing', key));

  /* Then */
  assert.deepEqual(actions, ['send', null, 'dismiss', null]);
});

test('waiting: Esc cancels, and Enter and Tab are kept from the box', () => {
  /* When */
  const actions = [press('Escape'), press('Enter'), press('Tab')].map(key => quickAskKey('waiting', key));

  /* Then */
  assert.deepEqual(actions, ['cancel', 'swallow', 'swallow']);
});

test('choosing: the arrows move, Enter starts, Tab opens the picker, Esc closes the list', () => {
  /* When */
  const actions = [press('ArrowUp'), press('ArrowDown'), press('Enter'), press('Tab'), press('Escape')]
    .map(key => quickAskKey('choosing', key));

  /* Then */
  assert.deepEqual(actions, ['up', 'down', 'start', 'picker', 'close']);
});

test('saving: Esc does not cancel a capture half-written', () => {
  /* When */
  const actions = [press('Escape'), press('Enter')].map(key => quickAskKey('saving', key));

  /* Then */
  assert.deepEqual(actions, ['swallow', 'swallow']);
});

test('saved: ⌘Z undoes, and Shift+⌘Z and a plain z are kept', () => {
  /* When */
  const actions = [
    { ...press('z'), metaKey: true }, { ...press('Z', true), metaKey: true }, press('z'), { ...press('z'), metaKey: true },
  ].map((key, i) => quickAskKey(i < 3 ? 'saved' : 'started', key));

  /* Then */
  assert.deepEqual(actions, ['undo', 'swallow', 'swallow', 'swallow']);
});

test('undoing: every key is kept, Esc too', () => {
  /* When */
  const actions = [press('Escape'), press('Enter'), press('a')].map(key => quickAskKey('undoing', key));

  /* Then */
  assert.deepEqual(actions, ['swallow', 'swallow', 'swallow']);
});

test('a result showing: Esc closes, and every other key is kept', () => {
  /* When */
  const actions = [
    quickAskKey('started', press('Escape')), quickAskKey('started', press('x')), quickAskKey('saved', press('Escape')),
    quickAskKey('undone', press('Escape')), quickAskKey('undone', press('x')),
  ];

  /* Then */
  assert.deepEqual(actions, ['dismiss', 'swallow', 'dismiss', 'dismiss', 'swallow']);
});

test('a key mid-composition belongs to the composition', () => {
  /* When */
  const actions = [press('Escape', false, true), press('Enter', false, true)].map(key => quickAskKey('editing', key));

  /* Then */
  assert.deepEqual(actions, [null, null]);
});

// ── The slab ──

test('the pointer is over the slab inside its box, and not on or past its far edges', () => {
  /* Given */
  const rect = { left: 20, top: 20, width: 640, height: 64 };
  const points = [[20, 20], [340, 60], [660, 60], [340, 84], [10, 60], [340, 300]];

  /* When */
  const over = points.map(([x, y]) => overSlab(x, y, rect));

  /* Then */
  assert.deepEqual(over, [true, true, false, false, false, false]);
});

// ── Placement ──

test('the window is centred on the display, the slab’s top a quarter of the way down', () => {
  /* Given */
  const area = { x: 0, y: 25, width: 1800, height: 1144 };

  /* When */
  const bounds = quickAskBounds(area);

  /* Then */
  assert.equal(bounds.x, (1800 - QUICK_ASK_SIZE.width) / 2);
  assert.equal(bounds.y + SLAB_TOP, 25 + 1144 / 4);
  assert.equal(bounds.width, QUICK_ASK_SIZE.width);
  assert.equal(bounds.height, QUICK_ASK_SIZE.height);
});

test('on a second display, it goes on that display', () => {
  /* Given */
  const area = { x: -1920, y: -300, width: 1920, height: 1055 };

  /* When */
  const bounds = quickAskBounds(area);

  /* Then */
  assert.equal(bounds.x, Math.round(-1920 + (1920 - QUICK_ASK_SIZE.width) / 2));
  assert.equal(bounds.y, Math.round(-300 + 1055 / 4 - SLAB_TOP));
});
