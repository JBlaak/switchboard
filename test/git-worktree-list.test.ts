import { test } from 'node:test';
import assert from 'node:assert';
import { parseWorktreeList } from '../src/domain/git/worktree-list';

const SHA = (n: string) => n.repeat(40);

const LISTING = [
  'worktree /Users/j/dev/proj',
  `HEAD ${SHA('1')}`,
  'branch refs/heads/main',
  '',
  'worktree /Users/j/dev/proj/.claude/worktrees/feat-x',
  `HEAD ${SHA('2')}`,
  'branch refs/heads/feat/x',
  '',
  'worktree /Users/j/dev/proj-detached',
  `HEAD ${SHA('3')}`,
  'detached',
  '',
  'worktree /Users/j/dev/proj-locked',
  `HEAD ${SHA('4')}`,
  'branch refs/heads/locked-work',
  'locked working on it',
  '',
  'worktree /Users/j/dev/bare.git',
  'bare',
  '',
  'worktree /Users/j/dev/proj-gone',
  `HEAD ${SHA('5')}`,
  'branch refs/heads/gone',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

test('parseWorktreeList reads the primary, a branch worktree, a detached one and a locked one', () => {
  const worktrees = parseWorktreeList(LISTING);
  assert.deepStrictEqual(worktrees.map(w => w.path), [
    '/Users/j/dev/proj',
    '/Users/j/dev/proj/.claude/worktrees/feat-x',
    '/Users/j/dev/proj-detached',
    '/Users/j/dev/proj-locked',
  ], 'bare and prunable records are dropped');

  const [primary, feature, detached, locked] = worktrees;
  assert.strictEqual(primary.isPrimary, true, 'the first record git prints is the main working tree');
  assert.strictEqual(primary.branch, 'main', 'refs/heads/ is stripped');
  assert.strictEqual(primary.head, SHA('1'));
  assert.strictEqual(primary.detached, false);
  assert.strictEqual(primary.locked, undefined, 'an unlocked worktree has no lock reason at all');

  assert.strictEqual(feature.isPrimary, false);
  assert.strictEqual(feature.branch, 'feat/x', 'a branch with a slash keeps everything after refs/heads/');

  assert.strictEqual(detached.detached, true);
  assert.strictEqual(detached.branch, null, 'a detached HEAD has no branch');
  assert.strictEqual(detached.head, SHA('3'));

  assert.strictEqual(locked.locked, 'working on it', 'the lock reason is kept');
  assert.strictEqual(locked.branch, 'locked-work');
});

test('parseWorktreeList records a lock without a reason as an empty string', () => {
  const out = `worktree /w\nHEAD ${SHA('a')}\nbranch refs/heads/x\nlocked\n`;
  const [w] = parseWorktreeList(out);
  assert.strictEqual(w.locked, '', "locked with no reason is '' — distinct from not locked");
});

test('parseWorktreeList drops bare and prunable records even when they come first', () => {
  const out = [
    'worktree /srv/repo.git',
    'bare',
    '',
    'worktree /srv/checkouts/a',
    `HEAD ${SHA('b')}`,
    'branch refs/heads/a',
    '',
    'worktree /srv/checkouts/gone',
    `HEAD ${SHA('c')}`,
    'branch refs/heads/gone',
    'prunable',
    '',
  ].join('\n');
  const worktrees = parseWorktreeList(out);
  assert.deepStrictEqual(worktrees.map(w => w.path), ['/srv/checkouts/a']);
  // The main entry was the bare repo, so no surviving checkout is the main working tree.
  assert.strictEqual(worktrees[0].isPrimary, false);
});

test('parseWorktreeList strips trailing slashes from paths', () => {
  const out = `worktree /Users/j/dev/proj/\nHEAD ${SHA('d')}\nbranch refs/heads/main\n`;
  assert.strictEqual(parseWorktreeList(out)[0].path, '/Users/j/dev/proj');
});

test('parseWorktreeList tolerates CRLF line endings', () => {
  const out = LISTING.replace(/\n/g, '\r\n');
  const worktrees = parseWorktreeList(out);
  assert.strictEqual(worktrees.length, 4);
  assert.strictEqual(worktrees[0].branch, 'main', 'no stray \\r on the last field of a line');
  assert.strictEqual(worktrees[0].head, SHA('1'));
  assert.strictEqual(worktrees[3].locked, 'working on it');
});

test('parseWorktreeList tolerates a missing final newline', () => {
  const out = `worktree /a\nHEAD ${SHA('e')}\nbranch refs/heads/main\n\nworktree /b\nHEAD ${SHA('f')}\ndetached`;
  const worktrees = parseWorktreeList(out);
  assert.strictEqual(worktrees.length, 2);
  assert.strictEqual(worktrees[1].path, '/b');
  assert.strictEqual(worktrees[1].detached, true, 'the last attribute is read even without a newline after it');
});

test('parseWorktreeList returns nothing for empty output', () => {
  assert.deepStrictEqual(parseWorktreeList(''), []);
  assert.deepStrictEqual(parseWorktreeList('\n'), []);
});
