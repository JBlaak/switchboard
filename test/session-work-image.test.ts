import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IMAGE_AUTO_LOAD_BYTES, imageFormatOf, imagePaths } from '../src/domain/session-work/image';

test('imageFormatOf names every image format by its extension', () => {
  /* Given */
  const cases: [string, string][] = [
    ['logo.png', 'png'],
    ['photo.jpg', 'jpeg'],
    ['photo.jpeg', 'jpeg'],
    ['spinner.gif', 'gif'],
    ['hero.webp', 'webp'],
    ['hero.avif', 'avif'],
    ['old.bmp', 'bmp'],
    ['favicon.ico', 'ico'],
    ['src/assets/icon.svg', 'svg'],
  ];

  for (const [path, expected] of cases) {
    /* When */
    const format = imageFormatOf(path);

    /* Then */
    assert.equal(format, expected, path);
  }
});

test('imageFormatOf ignores the extension\'s case', () => {
  /* Given */
  const paths = ['LOGO.PNG', 'Photo.JPG', 'Photo.Jpeg', 'icon.SVG'];

  /* When */
  const formats = paths.map(imageFormatOf);

  /* Then */
  assert.deepEqual(formats, ['png', 'jpeg', 'jpeg', 'svg']);
});

test('imageFormatOf is null for anything that is not an image', () => {
  /* Given */
  const paths = ['a.txt', 'src/main.ts', 'png', '.png', 'assets.png/readme', 'logo.png.bak', 'Makefile', 'doc.pdf', 'clip.tiff'];

  /* When */
  const formats = paths.map(imageFormatOf);

  /* Then */
  assert.deepEqual(formats, paths.map(() => null));
});

test('IMAGE_AUTO_LOAD_BYTES is 5 MB', () => {
  /* When */
  const limit = IMAGE_AUTO_LOAD_BYTES;

  /* Then */
  assert.equal(limit, 5 * 1024 * 1024);
});

test('imagePaths reads a renamed file\'s before at its old path', () => {
  /* When */
  const paths = imagePaths({ path: 'img/b.png', oldPath: 'img/a.png', status: 'renamed' });

  /* Then */
  assert.deepEqual(paths, { before: 'img/a.png', after: 'img/b.png' });
});

test('imagePaths gives an added file no before and a deleted one no after', () => {
  /* When */
  const added = imagePaths({ path: 'new.png', status: 'added' });
  const deleted = imagePaths({ path: 'old.png', status: 'deleted' });
  const modified = imagePaths({ path: 'same.png', status: 'modified' });

  /* Then */
  assert.deepEqual(added, { before: null, after: 'new.png' });
  assert.deepEqual(deleted, { before: 'old.png', after: null });
  assert.deepEqual(modified, { before: 'same.png', after: 'same.png' });
});
