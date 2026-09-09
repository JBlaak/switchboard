import { test } from 'node:test';
import assert from 'node:assert';
import { absolutePathFor, breadcrumbSegments } from '../src/renderer/features/code/code-path';

/**
 * The code area's path rules, exercised without a DOM.
 *
 * `code-path.ts` is deliberately the only part of the code area with decisions
 * in it — `code-area.ts` builds elements and shows panels — and it imports
 * nothing that touches `document`, which is what lets this file import it at
 * all. The renderer has no jsdom harness and does not want one.
 */

const WORKTREE = '/Users/j/dev/proj';
const WIN_WORKTREE = 'C:\\Users\\j\\dev\\proj';

// ── the crumbs a header shows ─────────────────────────────────────────────────

test('a relative path is its own breadcrumb', () => {
  assert.deepStrictEqual(
    breadcrumbSegments(WORKTREE, 'src/renderer/app.ts'),
    ['src', 'renderer', 'app.ts'],
  );
  assert.deepStrictEqual(breadcrumbSegments(WORKTREE, 'README.md'), ['README.md']);
  assert.deepStrictEqual(breadcrumbSegments(WORKTREE, ''), []);
});

test('the noise a caller may pass is dropped', () => {
  // A leading './', doubled separators, and a trailing separator all come from
  // paths that were joined by hand somewhere upstream.
  assert.deepStrictEqual(breadcrumbSegments(WORKTREE, './src/app.ts'), ['src', 'app.ts']);
  assert.deepStrictEqual(breadcrumbSegments(WORKTREE, 'src//app.ts'), ['src', 'app.ts']);
  assert.deepStrictEqual(breadcrumbSegments(WORKTREE, 'src/./app.ts'), ['src', 'app.ts']);
  assert.deepStrictEqual(breadcrumbSegments(WORKTREE, 'src/'), ['src']);
});

test('either separator splits', () => {
  assert.deepStrictEqual(breadcrumbSegments(WIN_WORKTREE, 'src\\app.ts'), ['src', 'app.ts']);
  assert.deepStrictEqual(breadcrumbSegments(WIN_WORKTREE, 'src\\lib/app.ts'), ['src', 'lib', 'app.ts']);
});

test('a path that already names its root is reduced to the part inside the worktree', () => {
  assert.deepStrictEqual(
    breadcrumbSegments(WORKTREE, '/Users/j/dev/proj/src/app.ts'),
    ['src', 'app.ts'],
  );
  assert.deepStrictEqual(
    breadcrumbSegments(WIN_WORKTREE, 'C:\\Users\\j\\dev\\proj\\src\\app.ts'),
    ['src', 'app.ts'],
  );
  // A trailing separator on the root is not a fourth segment.
  assert.deepStrictEqual(
    breadcrumbSegments('/Users/j/dev/proj/', '/Users/j/dev/proj/src/app.ts'),
    ['src', 'app.ts'],
  );
  // The worktree itself has nothing below it to show.
  assert.deepStrictEqual(breadcrumbSegments(WORKTREE, WORKTREE), []);
});

test('a relative path that repeats the root is left alone', () => {
  // 'Users/j/dev/proj/x' relative to the worktree is a real (if odd) nesting,
  // and only a path that names its own root can be the absolute one.
  assert.deepStrictEqual(
    breadcrumbSegments(WORKTREE, 'Users/j/dev/proj/x.ts'),
    ['Users', 'j', 'dev', 'proj', 'x.ts'],
  );
});

test('an absolute path outside the worktree keeps every segment', () => {
  // There is no shorter true answer; showing only the tail would hide where the
  // file came from.
  assert.deepStrictEqual(
    breadcrumbSegments(WORKTREE, '/etc/hosts'),
    ['etc', 'hosts'],
  );
});

// ── the path the watcher and the copy-path button get ─────────────────────────

test('the worktree and the file are joined with the host separator', () => {
  assert.strictEqual(absolutePathFor(WORKTREE, 'src/app.ts'), '/Users/j/dev/proj/src/app.ts');
  assert.strictEqual(absolutePathFor(WORKTREE, './src/app.ts'), '/Users/j/dev/proj/src/app.ts');
  assert.strictEqual(
    absolutePathFor(WIN_WORKTREE, 'src/app.ts'),
    'C:\\Users\\j\\dev\\proj\\src\\app.ts',
  );
});

test('joining is idempotent, so a caller may pass either form', () => {
  // The Files tab may hold the absolute path already; the watcher has to be
  // registered with the same string either way, since main echoes it back on
  // change and the panel compares them.
  const joined = absolutePathFor(WORKTREE, 'src/app.ts');
  assert.strictEqual(absolutePathFor(WORKTREE, joined), joined);
  assert.strictEqual(
    absolutePathFor(WIN_WORKTREE, 'C:\\Users\\j\\dev\\proj\\src\\app.ts'),
    'C:\\Users\\j\\dev\\proj\\src\\app.ts',
  );
});

test('a trailing separator on the worktree does not double up', () => {
  assert.strictEqual(absolutePathFor('/Users/j/dev/proj/', 'src/app.ts'), '/Users/j/dev/proj/src/app.ts');
  assert.strictEqual(absolutePathFor('/', 'app.ts'), '/app.ts');
  assert.strictEqual(absolutePathFor('C:\\', 'app.ts'), 'C:\\app.ts');
});

test('an absolute path outside the worktree is already the answer', () => {
  // Rooting it under the worktree again would name a file that is not there.
  assert.strictEqual(absolutePathFor(WORKTREE, '/etc/hosts'), '/etc/hosts');
});

test('nothing below the worktree is the worktree', () => {
  assert.strictEqual(absolutePathFor(WORKTREE, ''), '/Users/j/dev/proj');
});
