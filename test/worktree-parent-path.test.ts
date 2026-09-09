/**
 * Which repository a worktree cwd belongs to.
 *
 * The separator cases are the point. A cwd is read out of a transcript, so on
 * Windows it arrives backslash-separated, and the pattern this function matches
 * on is written with forward slashes — before the fold was made separator-blind,
 * every Windows worktree session was attributed to itself instead of to the
 * repository it was cut from, and the project rail's worktree scoping could
 * never have worked there. These assertions use literal paths so they pin the
 * behaviour on every platform, not only on the one running them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { worktreeParentPath } from '../src/domain/project/project-path';

test('a posix worktree cwd folds into its repository', () => {
  assert.strictEqual(
    worktreeParentPath('/Users/x/dev/repo/.claude/worktrees/feat'),
    '/Users/x/dev/repo',
    'the .claude/worktrees shape is the one Claude CLI writes today');
  assert.strictEqual(
    worktreeParentPath('/Users/x/dev/repo/.claude-worktrees/feat'),
    '/Users/x/dev/repo',
    'and the two older variants still have to fold');
  assert.strictEqual(
    worktreeParentPath('/Users/x/dev/repo/.worktrees/feat'),
    '/Users/x/dev/repo');
});

test('a windows worktree cwd folds, and keeps its own separators', () => {
  assert.strictEqual(
    worktreeParentPath('C:\\Users\\RUNNER~1\\Temp\\repo\\.claude\\worktrees\\feat'),
    'C:\\Users\\RUNNER~1\\Temp\\repo',
    'the parent is handed back backslashed — a caller compares it to other Windows paths');
  assert.strictEqual(
    worktreeParentPath('C:\\dev\\repo\\.claude-worktrees\\feat'),
    'C:\\dev\\repo');
});

test('a trailing separator does not change the answer', () => {
  assert.strictEqual(worktreeParentPath('/Users/x/repo/.claude/worktrees/feat/'), '/Users/x/repo');
  assert.strictEqual(worktreeParentPath('C:\\dev\\repo\\.claude\\worktrees\\feat\\'), 'C:\\dev\\repo');
});

test('anything that is not a worktree is not folded', () => {
  assert.strictEqual(worktreeParentPath('/Users/x/dev/repo'), null, 'a plain project');
  assert.strictEqual(worktreeParentPath('C:\\dev\\repo'), null);
  assert.strictEqual(
    worktreeParentPath('/Users/x/dev/repo/.claude/worktrees/feat/src'),
    null,
    'a directory inside a worktree is not the worktree itself');
  assert.strictEqual(
    worktreeParentPath('/Users/x/dev/repo/.claude/plans'),
    null,
    'another .claude directory is not a worktree');
  assert.strictEqual(worktreeParentPath(''), null);
  assert.strictEqual(worktreeParentPath(null), null);
  assert.strictEqual(worktreeParentPath(undefined), null);
});
