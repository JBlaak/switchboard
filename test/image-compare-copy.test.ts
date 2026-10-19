import { test } from 'node:test';
import assert from 'node:assert/strict';

import { copiedSide } from '../src/renderer/ui/session-work/image-compare/copy-image';

test('copied side: side-by-side and swipe copy the side the pointer was over', () => {
  /* Given */
  const pointed = 'before';

  /* When */
  const sides = [copiedSide('side-by-side', 'after', pointed), copiedSide('swipe', 'after', pointed)];

  /* Then */
  assert.deepEqual(sides, ['before', 'before']);
});

test('copied side: side-by-side and swipe copy the after when the pointer was over neither', () => {
  /* Given */
  const pointed = null;

  /* When */
  const sides = [copiedSide('side-by-side', 'before', pointed), copiedSide('swipe', 'before', pointed)];

  /* Then */
  assert.deepEqual(sides, ['after', 'after']);
});

test('copied side: blink copies the side showing, wherever the pointer was', () => {
  /* Given */
  const showing = 'before';

  /* When */
  const side = copiedSide('blink', showing, 'after');

  /* Then */
  assert.equal(side, 'before');
});

test('copied side: onion skin and pixel diff copy the after', () => {
  /* Given */
  const pointed = 'before';

  /* When */
  const sides = [copiedSide('onion', 'before', pointed), copiedSide('pixel-diff', 'before', pointed)];

  /* Then */
  assert.deepEqual(sides, ['after', 'after']);
});
