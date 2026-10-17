import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLICK_SLOP, contentSize, describeChange, dividerOnScreen, dragDivider, initialDivider, isClick, parseCssColor,
} from '../src/renderer/ui/session-work/image-compare/modes/overlay';
import { zoomAt } from '../src/renderer/ui/session-work/image-compare/viewport';
import type { View } from '../src/renderer/ui/session-work/image-compare/types';

// ── Content size ──

test('content size: the larger of the two images on each axis', () => {
  /* Given */
  const before = { width: 300, height: 100 };
  const after = { width: 200, height: 400 };

  /* When */
  const size = contentSize(before, after);

  /* Then */
  assert.deepEqual(size, { width: 300, height: 400 });
});

// ── Swipe divider ──

test('divider: starts halfway across the wider image', () => {
  /* Given */
  const content = contentSize({ width: 200, height: 50 }, { width: 600, height: 50 });

  /* When */
  const divider = initialDivider(content);

  /* Then */
  assert.equal(divider, 300);
});

test('divider: lands where its content pixel is drawn under zoom and pan', () => {
  /* Given */
  const view: View = { scale: 4, x: -100, y: 20 };

  /* When */
  const x = dividerOnScreen(50, view);

  /* Then */
  assert.equal(x, 100);
});

test('divider: zooming about the divider leaves it under the cursor', () => {
  /* Given */
  const divider = 120;
  const view: View = { scale: 1, x: 30, y: 0 };
  const cursor = { x: dividerOnScreen(divider, view), y: 50 };

  /* When */
  const zoomed = zoomAt(view, 3, cursor);

  /* Then */
  assert.ok(Math.abs(dividerOnScreen(divider, zoomed) - cursor.x) < 1e-9);
});

test('divider: a drag at 4x moves it a quarter as far in content pixels', () => {
  /* Given */
  const view: View = { scale: 4, x: 0, y: 0 };

  /* When */
  const divider = dragDivider(100, 40, view, { width: 400, height: 100 });

  /* Then */
  assert.equal(divider, 110);
});

test('divider: a drag past either edge stops at the content edge', () => {
  /* Given */
  const view: View = { scale: 0.5, x: 0, y: 0 };
  const content = { width: 400, height: 100 };

  /* When */
  const left = dragDivider(100, -500, view, content);
  const right = dragDivider(100, 500, view, content);

  /* Then */
  assert.equal(left, 0);
  assert.equal(right, 400);
});

// ── Click versus drag ──

test('click: a press released where it started is a click', () => {
  /* When */
  const click = isClick({ x: 10, y: 10 }, { x: 12, y: 11 });

  /* Then */
  assert.equal(click, true);
});

test('click: a press that moved past the slop is a drag', () => {
  /* When */
  const click = isClick({ x: 10, y: 10 }, { x: 10 + CLICK_SLOP, y: 10 + CLICK_SLOP });

  /* Then */
  assert.equal(click, false);
});

// ── Pixel diff summary ──

test('summary: nothing changed reads as identical', () => {
  /* When */
  const line = describeChange(0, 10_000);

  /* Then */
  assert.equal(line, 'Pixels identical');
});

test('summary: a share to one decimal, with the count grouped', () => {
  /* When */
  const line = describeChange(14_201, 443_781);

  /* Then */
  assert.equal(line, '3.2% changed (14,201 px)');
});

test('summary: a single pixel in a large image is never shown as 0%', () => {
  /* When */
  const line = describeChange(1, 4_000_000);

  /* Then */
  assert.equal(line, '<0.1% changed (1 px)');
});

test('summary: all but one pixel is not rounded up to 100%', () => {
  /* When */
  const almost = describeChange(3_999_999, 4_000_000);
  const all = describeChange(400, 400);

  /* Then */
  assert.equal(almost, '>99.9% changed (3,999,999 px)');
  assert.equal(all, '100% changed (400 px)');
});

// ── CSS colours ──

test('colour: six-digit hex, as a token is written', () => {
  /* When */
  const rgb = parseCssColor(' #6cc4a1');

  /* Then */
  assert.deepEqual(rgb, [108, 196, 161]);
});

test('colour: short hex and hex with alpha', () => {
  /* When */
  const short = parseCssColor('#FFF');
  const withAlpha = parseCssColor('#2e8a6880');

  /* Then */
  assert.deepEqual(short, [255, 255, 255]);
  assert.deepEqual(withAlpha, [46, 138, 104]);
});

test('colour: rgb() and rgba() in comma and space syntax', () => {
  /* When */
  const comma = parseCssColor('rgb(20, 21, 23)');
  const alpha = parseCssColor('rgba(108, 196, 161, 0.5)');
  const space = parseCssColor('rgb(46 138 104 / 50%)');

  /* Then */
  assert.deepEqual(comma, [20, 21, 23]);
  assert.deepEqual(alpha, [108, 196, 161]);
  assert.deepEqual(space, [46, 138, 104]);
});

test('colour: an unset or unknown value is null', () => {
  /* When */
  const empty = parseCssColor('');
  const named = parseCssColor('green');

  /* Then */
  assert.equal(empty, null);
  assert.equal(named, null);
});
