import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeImages, formatBytes } from '../src/renderer/ui/session-work/image-compare/image-meta';

test('meta: both sides changed in size and bytes', () => {
  /* Given */
  const before = { width: 1024, height: 768, bytes: 48 * 1024 };
  const after = { width: 2048, height: 1536, bytes: 112 * 1024 };

  /* When */
  const line = describeImages('png', before, after);

  /* Then */
  assert.equal(line, '1024×768 → 2048×1536 · 48 KB → 112 KB · PNG');
});

test('meta: unchanged dimensions are written once', () => {
  /* Given */
  const before = { width: 512, height: 512, bytes: 48 * 1024 };
  const after = { width: 512, height: 512, bytes: 40 * 1024 };

  /* When */
  const line = describeImages('png', before, after);

  /* Then */
  assert.equal(line, '512×512 · 48 KB → 40 KB · PNG');
});

test('meta: an added image shows only its own side', () => {
  /* When */
  const line = describeImages('jpeg', null, { width: 640, height: 480, bytes: 2048 });

  /* Then */
  assert.equal(line, '640×480 · 2 KB · JPEG');
});

test('meta: a deleted image shows only its own side', () => {
  /* When */
  const line = describeImages('svg', { width: 24, height: 24, bytes: 900 });

  /* Then */
  assert.equal(line, '24×24 · 900 B · SVG');
});

test('bytes: rounded to one decimal under ten, whole above', () => {
  /* When */
  const shown = [0, 1023, 1536, 48 * 1024, 1.5 * 1024 * 1024, 30 * 1024 * 1024].map(formatBytes);

  /* Then */
  assert.deepEqual(shown, ['0 B', '1023 B', '1.5 KB', '48 KB', '1.5 MB', '30 MB']);
});
