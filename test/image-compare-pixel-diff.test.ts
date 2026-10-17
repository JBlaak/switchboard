import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pixelDiff } from '../src/renderer/ui/session-work/image-compare/pixel-diff';
import type { Pixels, Rgb } from '../src/renderer/ui/session-work/image-compare/types';

const GREEN: Rgb = [108, 196, 161];
const options = { threshold: 0.1, tint: GREEN, fade: [255, 255, 255] as Rgb };

/** A `width` × `height` image of one opaque colour. */
function solid(width: number, height: number, [r, g, b]: Rgb): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  return { width, height, data };
}

function setPixel(image: Pixels, x: number, y: number, [r, g, b]: Rgb): void {
  image.data.set([r, g, b, 255], (y * image.width + x) * 4);
}

function pixelAt(image: Pixels, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(at, at + 4));
}

test('identical images: nothing changed, and nothing is tinted', () => {
  /* Given */
  const before = solid(4, 4, [200, 50, 50]);
  const after = solid(4, 4, [200, 50, 50]);

  /* When */
  const diff = pixelDiff(before, after, options);

  /* Then */
  assert.equal(diff.changed, 0);
  assert.equal(diff.total, 16);
  assert.notDeepEqual(pixelAt(diff.image, 0, 0), [...GREEN, 255]);
});

test('one changed pixel: counted and painted in the tint', () => {
  /* Given */
  const before = solid(5, 5, [255, 255, 255]);
  const after = solid(5, 5, [255, 255, 255]);
  setPixel(after, 2, 2, [0, 0, 0]);

  /* When */
  const diff = pixelDiff(before, after, options);

  /* Then */
  assert.equal(diff.changed, 1);
  assert.deepEqual(pixelAt(diff.image, 2, 2), [...GREEN, 255]);
  assert.deepEqual(pixelAt(diff.image, 0, 0), [255, 255, 255, 255]);
});

test('unchanged pixels are the after image in grey, faded toward the fade colour', () => {
  /* Given */
  const before = solid(2, 2, [0, 0, 0]);
  const after = solid(2, 2, [0, 0, 0]);

  /* When */
  const diff = pixelDiff(before, after, { ...options, fade: [100, 100, 100] });

  /* Then */
  const [r, g, b, a] = pixelAt(diff.image, 1, 1);
  assert.equal(r, g);
  assert.equal(g, b);
  assert.ok(r < 100 && r > 0, `faded part of the way from black to the fade, got ${r}`);
  assert.equal(a, 255);
});

test('different sizes: the canvas is the larger of each and the part outside the overlap is changed', () => {
  /* Given */
  const before = solid(4, 2, [10, 10, 10]);
  const after = solid(2, 3, [10, 10, 10]);

  /* When */
  const diff = pixelDiff(before, after, options);

  /* Then */
  assert.equal(diff.image.width, 4);
  assert.equal(diff.image.height, 3);
  assert.equal(diff.total, 12);
  assert.equal(diff.changed, 12 - 4);
  assert.deepEqual(pixelAt(diff.image, 3, 0), [...GREEN, 255]);
  assert.deepEqual(pixelAt(diff.image, 0, 2), [...GREEN, 255]);
  assert.notDeepEqual(pixelAt(diff.image, 1, 1), [...GREEN, 255]);
});

test('threshold: a slight shift counts at a strict threshold and not at a loose one', () => {
  /* Given */
  const before = solid(3, 3, [120, 120, 120]);
  const after = solid(3, 3, [120, 120, 120]);
  setPixel(after, 1, 1, [150, 150, 150]);

  /* When */
  const strict = pixelDiff(before, after, { ...options, threshold: 0.01 });
  const loose = pixelDiff(before, after, { ...options, threshold: 0.5 });

  /* Then */
  assert.equal(strict.changed, 1);
  assert.equal(loose.changed, 0);
});
