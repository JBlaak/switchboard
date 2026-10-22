import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitCliWorkspace, parseWorktreeList } from '../src/infrastructure/git/git-cli-workspace';

// Keep the developer's own git config out of both the fixture and the adapter.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = os.devNull;

/** `git worktree list --porcelain -z` output: each record's fields NUL-terminated, records ended by one more NUL. */
const porcelain = (...records: string[][]) => records.map((fields) => fields.map((field) => field + '\0').join('') + '\0').join('');

// ── Parsing recorded output ──

test('a bare main repository, a branch, a detached HEAD and a locked worktree parse into records', () => {
  /* Given */
  const output = porcelain(
    ['worktree /src/app.git', 'bare'],
    ['worktree /src/app-main', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'],
    ['worktree /src/app-detached', 'HEAD 2222222222222222222222222222222222222222', 'detached'],
    ['worktree /src/app-locked', 'HEAD 3333333333333333333333333333333333333333', 'branch refs/heads/169-reads', 'locked on the external disk'],
    ['worktree /src/app-gone', 'HEAD 4444444444444444444444444444444444444444', 'branch refs/heads/old', 'prunable gitdir file points to non-existent location'],
  );

  /* When */
  const entries = parseWorktreeList(output);

  /* Then */
  const none = { head: null, branch: null, main: false, bare: false, detached: false, locked: false, prunable: false };
  assert.deepEqual(entries, [
    { ...none, path: '/src/app.git', main: true, bare: true },
    { ...none, path: '/src/app-main', head: '1111111111111111111111111111111111111111', branch: 'main' },
    { ...none, path: '/src/app-detached', head: '2222222222222222222222222222222222222222', detached: true },
    { ...none, path: '/src/app-locked', head: '3333333333333333333333333333333333333333', branch: '169-reads', locked: true },
    { ...none, path: '/src/app-gone', head: '4444444444444444444444444444444444444444', branch: 'old', prunable: true },
  ]);
});

test('a path with spaces and a branch with slashes are kept whole', () => {
  /* Given */
  const output = porcelain(
    ['worktree /Users/me/My Projects/app', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/feature/a b'],
    ['worktree /Users/me/My Projects/app/.claude/worktrees/x', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/x', 'locked'],
  );

  /* When */
  const entries = parseWorktreeList(output);

  /* Then */
  assert.deepEqual(entries.map((entry) => [entry.path, entry.branch, entry.main, entry.locked]), [
    ['/Users/me/My Projects/app', 'feature/a b', true, false],
    ['/Users/me/My Projects/app/.claude/worktrees/x', 'x', false, true],
  ]);
});

test('empty output is no worktrees', () => {
  /* When */
  const entries = parseWorktreeList('');

  /* Then */
  assert.deepEqual(entries, []);
});

// ── Against a real repository ──

const git = new GitCliWorkspace();
let tmp: string;
let repo: string;

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commit(dir: string, file: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), message + '\n');
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', message);
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-worktree-list-')));
  const origin = path.join(tmp, 'origin.git');
  const pusher = path.join(tmp, 'pusher');
  repo = path.join(tmp, 'repo');

  run(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  run(tmp, 'clone', '-q', origin, pusher);
  commit(pusher, 'a.txt', 'Initial');
  run(pusher, 'push', '-q', 'origin', 'HEAD:main');
  run(tmp, 'clone', '-q', origin, repo);

  // Merged: a branch whose commit went to origin's main.
  run(repo, 'worktree', 'add', '-q', '-b', 'merged-work', path.join(tmp, 'merged'));
  commit(path.join(tmp, 'merged'), 'm.txt', 'Merged work');
  run(path.join(tmp, 'merged'), 'push', '-q', 'origin', 'HEAD:main');
  run(repo, 'fetch', '-q', 'origin');

  // Ahead by two, with one changed and one untracked file, and locked.
  const ahead = path.join(tmp, 'ahead');
  run(repo, 'worktree', 'add', '-q', '-b', 'ahead-work', ahead, 'origin/main');
  commit(ahead, 'b.txt', 'One');
  commit(ahead, 'c.txt', 'Two');
  fs.writeFileSync(path.join(ahead, 'b.txt'), 'edited\n');
  fs.writeFileSync(path.join(ahead, 'new.txt'), 'new\n');
  run(repo, 'worktree', 'lock', ahead);

  // Detached on a commit of its own.
  const detached = path.join(tmp, 'detached');
  run(repo, 'worktree', 'add', '-q', '--detach', detached, 'origin/main');
  commit(detached, 'd.txt', 'Detached');

  // Gone: its directory removed without telling git.
  run(repo, 'worktree', 'add', '-q', '-b', 'gone-work', path.join(tmp, 'gone'));
  fs.rmSync(path.join(tmp, 'gone'), { recursive: true, force: true });
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('worktrees lists each checkout with its branch, changes, ahead count and whether it is merged', async () => {
  /* When */
  const worktrees = await git.worktrees(repo);

  /* Then */
  assert.deepEqual(worktrees[0], { path: repo, branch: 'main', main: true, locked: false, changedFiles: 0, ahead: 0, merged: false });
  // git lists linked worktrees in the order it finds them on disk.
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  assert.deepEqual(worktrees.slice(1).sort(byPath), [
    { path: path.join(tmp, 'ahead'), branch: 'ahead-work', main: false, locked: true, changedFiles: 2, ahead: 2, merged: false },
    { path: path.join(tmp, 'detached'), branch: null, main: false, locked: false, changedFiles: 0, ahead: 1, merged: false },
    { path: path.join(tmp, 'merged'), branch: 'merged-work', main: false, locked: false, changedFiles: 0, ahead: 0, merged: true },
  ]);
});

test('worktrees answers the same list asked from a linked worktree', async () => {
  /* When */
  const worktrees = await git.worktrees(path.join(tmp, 'ahead'));

  /* Then */
  assert.equal(worktrees[0].path, repo);
  assert.deepEqual(worktrees.map((worktree) => worktree.branch).sort(), ['ahead-work', 'main', 'merged-work', null].sort());
});

test('worktrees answers none outside a repository', async () => {
  /* When */
  const worktrees = await git.worktrees(tmp);

  /* Then */
  assert.deepEqual(worktrees, []);
});
