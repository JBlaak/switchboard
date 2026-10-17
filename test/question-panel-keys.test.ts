import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelKey } from '../src/renderer/features/questions/question-keys';
import type { PanelKey, PanelKeyEvent, PanelKeyPlace } from '../src/renderer/features/questions/question-keys';

/** A key on a two-option question, on the panel itself unless `at` says otherwise. */
function press(key: string, at: Partial<PanelKeyPlace> = {}, mods: Partial<PanelKeyEvent> = {}): PanelKey {
  return panelKey(
    { key, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods },
    { inOther: false, onPatch: false, options: 2, ...at },
  );
}

const keys = (list: string[], at?: Partial<PanelKeyPlace>) => list.map(key => press(key, at));

test('Cmd, Ctrl and Alt combinations go on to the app', () => {
  /* When */
  const pressed = [press('k', {}, { metaKey: true }), press('2', {}, { ctrlKey: true }), press('Enter', {}, { altKey: true })];

  /* Then */
  assert.deepEqual(pressed, [{ does: 'pass' }, { does: 'pass' }, { does: 'pass' }]);
});

test('Tab goes on to the app', () => {
  /* When */
  const pressed = press('Tab');

  /* Then */
  assert.deepEqual(pressed, { does: 'pass' });
});

test('keys during IME composition are left alone', () => {
  /* When */
  const pressed = press('2', {}, { isComposing: true });

  /* Then */
  assert.deepEqual(pressed, { does: 'pass' });
});

test('unmodified keys that mean nothing stop at the panel', () => {
  /* When */
  const pressed = keys(['x', 'n', 'Backspace']);

  /* Then */
  assert.deepEqual(pressed, [{ does: 'keep' }, { does: 'keep' }, { does: 'keep' }]);
});

test('up and down move the cursor', () => {
  /* When */
  const pressed = keys(['ArrowDown', 'ArrowUp']);

  /* Then */
  assert.deepEqual(pressed, [
    { does: 'act', action: { kind: 'move', by: 1 } },
    { does: 'act', action: { kind: 'move', by: -1 } },
  ]);
});

test('Enter and right go on, left goes back', () => {
  /* When */
  const pressed = keys(['Enter', 'ArrowRight', 'ArrowLeft']);

  /* Then */
  assert.deepEqual(pressed, [
    { does: 'act', action: { kind: 'next' } },
    { does: 'act', action: { kind: 'next' } },
    { does: 'act', action: { kind: 'back' } },
  ]);
});

test('Esc answers in the terminal instead', () => {
  /* When */
  const pressed = press('Escape');

  /* Then */
  assert.deepEqual(pressed, { does: 'terminal' });
});

test('numbers press their row, up to the Other row', () => {
  /* When */
  const pressed = keys(['1', '2', '3']);

  /* Then */
  assert.deepEqual(pressed, [
    { does: 'act', action: { kind: 'press', row: 0 } },
    { does: 'act', action: { kind: 'press', row: 1 } },
    { does: 'act', action: { kind: 'press', row: 2 } },
  ]);
});

test('numbers past the Other row, and 0, do nothing', () => {
  /* When */
  const pressed = keys(['4', '0']);

  /* Then */
  assert.deepEqual(pressed, [{ does: 'keep' }, { does: 'keep' }]);
});

test('space presses the row under the cursor', () => {
  /* When */
  const pressed = press(' ');

  /* Then */
  assert.deepEqual(pressed, { does: 'act', action: { kind: 'space' } });
});

test('typing in Other keeps numbers, space and left/right for the text', () => {
  /* When */
  const pressed = keys(['1', ' ', 'ArrowLeft', 'ArrowRight', 'x'], { inOther: true });

  /* Then */
  assert.deepEqual(pressed, [{ does: 'keep' }, { does: 'keep' }, { does: 'keep' }, { does: 'keep' }, { does: 'keep' }]);
});

test('from Other, Enter, up/down and Esc still act on the panel', () => {
  /* When */
  const pressed = keys(['Enter', 'ArrowUp', 'ArrowDown', 'Escape'], { inOther: true });

  /* Then */
  assert.deepEqual(pressed, [
    { does: 'act', action: { kind: 'next' } },
    { does: 'act', action: { kind: 'move', by: -1 } },
    { does: 'act', action: { kind: 'move', by: 1 } },
    { does: 'terminal' },
  ]);
});

test('Enter and Space on Patch are the button’s, to poke it', () => {
  /* When */
  const pressed = keys(['Enter', ' '], { onPatch: true });

  /* Then */
  assert.deepEqual(pressed, [{ does: 'keep' }, { does: 'keep' }]);
});

test('other keys on Patch still act on the panel', () => {
  /* When */
  const pressed = press('2', { onPatch: true });

  /* Then */
  assert.deepEqual(pressed, { does: 'act', action: { kind: 'press', row: 1 } });
});
