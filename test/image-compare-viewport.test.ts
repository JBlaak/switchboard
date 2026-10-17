import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fitView, MAX_SCALE, MIN_SCALE, panBy, showsGrid, toggleFitActual, zoomAt,
} from '../src/renderer/ui/session-work/image-compare/viewport';
import type { View } from '../src/renderer/ui/session-work/image-compare/types';

const frame = { width: 400, height: 300 };

/** The content pixel under a frame point. */
const contentAt = (view: View, point: { x: number; y: number }) => ({
  x: (point.x - view.x) / view.scale,
  y: (point.y - view.y) / view.scale,
});

test('fit: a wide image is scaled down to the frame width', () => {
  /* When */
  const view = fitView(frame, { width: 800, height: 600 });

  /* Then */
  assert.deepEqual(view, { scale: 0.5, x: 0, y: 0 });
});

test('fit: a small image is never upscaled, and is centred', () => {
  /* When */
  const view = fitView(frame, { width: 100, height: 50 });

  /* Then */
  assert.deepEqual(view, { scale: 1, x: 150, y: 125 });
});

test('zoom: the point under the cursor stays put', () => {
  /* Given */
  const view: View = { scale: 0.5, x: 10, y: 20 };
  const cursor = { x: 130, y: 90 };
  const before = contentAt(view, cursor);

  /* When */
  const next = zoomAt(view, 3, cursor);

  /* Then */
  assert.equal(next.scale, 1.5);
  const after = contentAt(next, cursor);
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('zoom: the scale is held between the minimum and the maximum', () => {
  /* Given */
  const view: View = { scale: 1, x: 0, y: 0 };

  /* When */
  const inward = zoomAt(view, 1000, { x: 0, y: 0 });
  const outward = zoomAt(view, 0.0001, { x: 0, y: 0 });

  /* Then */
  assert.equal(inward.scale, MAX_SCALE);
  assert.equal(outward.scale, MIN_SCALE);
});

test('zoom: a huge image may zoom out as far as its fit', () => {
  /* Given */
  const content = { width: 8000, height: 100 };
  const fit = fitView(frame, content);

  /* When */
  const next = zoomAt(fit, 0.5, { x: 0, y: 0 }, frame, content);

  /* Then */
  assert.equal(fit.scale, 0.05);
  assert.equal(next.scale, 0.05);
});

test('pan: moves the content by the drag', () => {
  /* Given */
  const content = { width: 800, height: 600 };

  /* When */
  const next = panBy({ scale: 1, x: 0, y: 0 }, -50, -20, frame, content);

  /* Then */
  assert.deepEqual(next, { scale: 1, x: -50, y: -20 });
});

test('pan: the content cannot be dragged fully out of the frame', () => {
  /* Given */
  const content = { width: 800, height: 600 };

  /* When */
  const left = panBy({ scale: 1, x: 0, y: 0 }, -5000, -5000, frame, content);
  const right = panBy({ scale: 1, x: 0, y: 0 }, 5000, 5000, frame, content);

  /* Then */
  assert.deepEqual(left, { scale: 1, x: 32 - 800, y: 32 - 600 });
  assert.deepEqual(right, { scale: 1, x: 400 - 32, y: 300 - 32 });
});

test('double-click: from fit goes to 1:1 at the clicked point', () => {
  /* Given */
  const content = { width: 800, height: 600 };
  const fit = fitView(frame, content);
  const click = { x: 100, y: 80 };
  const clicked = contentAt(fit, click);

  /* When */
  const next = toggleFitActual(fit, click, frame, content);

  /* Then */
  assert.equal(next.scale, 1);
  assert.deepEqual(contentAt(next, click), clicked);
});

test('double-click: from anywhere else goes back to fit', () => {
  /* Given */
  const content = { width: 800, height: 600 };

  /* When */
  const next = toggleFitActual({ scale: 4, x: -900, y: -700 }, { x: 10, y: 10 }, frame, content);

  /* Then */
  assert.deepEqual(next, fitView(frame, content));
});

test('grid: drawn from 8× on', () => {
  /* When */
  const shown = [4, 7.99, 8, 16].map((scale) => showsGrid({ scale, x: 0, y: 0 }));

  /* Then */
  assert.deepEqual(shown, [false, false, true, true]);
});
