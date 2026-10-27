import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitCliWorkspace } from '../src/infrastructure/git/git-cli-workspace';

// Keep the developer's own git config out of both the fixture and the adapter.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = os.devNull;

const git = new GitCliWorkspace();
let tmp: string;
let origin: string;
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-worktrees-')));
  origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'repo');
  const pusher = path.join(tmp, 'pusher');

  run(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  run(tmp, 'clone', '-q', origin, pusher);
  commit(pusher, 'a.txt', 'Initial');
  run(pusher, 'push', '-q', 'origin', 'HEAD:main');
  run(tmp, 'clone', '-q', origin, repo);

  // Origin moves on after the clone: a fetch is what brings these in.
  commit(pusher, 'b.txt', 'Main moved on');
  run(pusher, 'push', '-q', 'origin', 'HEAD:main');
  run(pusher, 'checkout', '-q', '-b', '113-overlay');
  commit(pusher, 'c.txt', 'Overlay');
  run(pusher, 'push', '-q', 'origin', '113-overlay');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('fetchBranch brings a branch origin has into origin/<branch>', async () => {
  /* When */
  const result = await git.fetchBranch(repo, '113-overlay');

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.equal(await git.commitSha(repo, 'origin/113-overlay'), run(origin, 'rev-parse', '113-overlay').trim());
});

test('fetchBranch answers git\'s reason for a branch origin does not have', async () => {
  /* When */
  const result = await git.fetchBranch(repo, 'no-such-branch');

  /* Then */
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /no-such-branch/);
});

test('addWorktree makes the directories, the branch off its base, and tracks nothing', async () => {
  /* Given */
  await git.fetchBranch(repo, 'main');
  const worktree = path.join(repo, '.claude', 'worktrees', '114-stage');

  /* When */
  const result = await git.addWorktree(repo, worktree, '114-stage', 'origin/main');

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.equal(await git.currentBranch(worktree), '114-stage');
  assert.equal(await git.commitSha(worktree, 'HEAD'), run(origin, 'rev-parse', 'main').trim());
  assert.equal(await git.isPushed(repo, '114-stage'), false);
});

test('addWorktree refuses a branch that exists, with git\'s reason', async () => {
  /* Given */
  run(repo, 'branch', '115-taken');

  /* When */
  const result = await git.addWorktree(repo, path.join(repo, '.claude', 'worktrees', '115-taken'), '115-taken', 'main');

  /* Then */
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /115-taken.*already exists/);
});

test('mainCheckout finds the main checkout from a linked worktree and from a subdirectory', async () => {
  /* Given */
  const worktree = path.join(tmp, 'linked');
  run(repo, 'worktree', 'add', '-q', '-b', 'linked', worktree, 'main');
  fs.mkdirSync(path.join(repo, 'sub'));

  /* When */
  const fromWorktree = await git.mainCheckout(worktree);
  const fromSub = await git.mainCheckout(path.join(repo, 'sub'));
  const outside = await git.mainCheckout(tmp);

  /* Then */
  assert.equal(fromWorktree, repo);
  assert.equal(fromSub, repo);
  assert.equal(outside, null);
});

test('addWorktree runs the checkout\'s filters off the tool environment\'s PATH', async () => {
  /* Given */
  // A repository whose checkout needs a filter that, like Homebrew's git-lfs,
  // is only on the login shell's PATH.
  const tools = path.join(tmp, 'tools');
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'fake-smudge'), '#!/bin/sh\ncat\n', { mode: 0o755 });
  const filtered = path.join(tmp, 'filtered');
  run(tmp, 'init', '-q', '-b', 'main', filtered);
  fs.writeFileSync(path.join(filtered, '.gitattributes'), '*.bin filter=fake\n');
  commit(filtered, 'asset.bin', 'Asset');
  run(filtered, 'config', 'filter.fake.smudge', 'fake-smudge');
  run(filtered, 'config', 'filter.fake.required', 'true');
  const bare = new GitCliWorkspace(async () => ({ ...process.env, PATH: '/usr/bin:/bin' }));
  const login = new GitCliWorkspace(async () => ({ ...process.env, PATH: `${tools}:/usr/bin:/bin` }));

  /* When */
  const withoutTool = await bare.addWorktree(filtered, path.join(tmp, 'filtered-bare'), '116-bare', 'main');
  const withTool = await login.addWorktree(filtered, path.join(tmp, 'filtered-login'), '116-login', 'main');

  /* Then */
  assert.equal(withoutTool.ok, false);
  assert.deepEqual(withTool, { ok: true });
  assert.equal(fs.readFileSync(path.join(tmp, 'filtered-login', 'asset.bin'), 'utf8'), 'Asset\n');
});

test('removeWorktree removes a clean worktree, its ignored files with it, and keeps its branch', async () => {
  /* Given */
  const worktree = path.join(tmp, 'clean');
  run(repo, 'worktree', 'add', '-q', '-b', '117-clean', worktree, 'main');
  fs.writeFileSync(path.join(worktree, '.gitignore'), 'node_modules/\n');
  run(worktree, 'add', '.gitignore');
  run(worktree, 'commit', '-q', '-m', 'Ignore node_modules');
  fs.mkdirSync(path.join(worktree, 'node_modules'));
  fs.writeFileSync(path.join(worktree, 'node_modules', 'dep.js'), '');

  /* When */
  const result = await git.removeWorktree(repo, worktree);

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(await git.branchExists(repo, '117-clean'), true);
});

test('removeWorktree refuses a worktree with untracked files, with git\'s reason', async () => {
  /* Given */
  const worktree = path.join(tmp, 'dirty');
  run(repo, 'worktree', 'add', '-q', '-b', '118-dirty', worktree, 'main');
  fs.writeFileSync(path.join(worktree, 'notes.txt'), 'not committed\n');

  /* When */
  const result = await git.removeWorktree(repo, worktree);

  /* Then */
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /untracked/);
  assert.equal(fs.existsSync(path.join(worktree, 'notes.txt')), true);
});

test('removeWorktree with force removes a worktree with uncommitted changes', async () => {
  /* Given */
  const worktree = path.join(tmp, 'forced');
  run(repo, 'worktree', 'add', '-q', '-b', '119-forced', worktree, 'main');
  fs.writeFileSync(path.join(worktree, 'notes.txt'), 'not committed\n');

  /* When */
  const result = await git.removeWorktree(repo, worktree, { force: true });

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.existsSync(worktree), false);
});

test('deleteBranch deletes a branch with commits nothing else has', async () => {
  /* Given */
  const worktree = path.join(tmp, 'unmerged');
  run(repo, 'worktree', 'add', '-q', '-b', '120-unmerged', worktree, 'main');
  commit(worktree, 'd.txt', 'Unmerged work');
  run(repo, 'worktree', 'remove', worktree);

  /* When */
  const result = await git.deleteBranch(repo, '120-unmerged');

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.equal(await git.branchExists(repo, '120-unmerged'), false);
});

test('a branch whose worktree directory has gone is free again after pruneWorktrees, and checkoutWorktree adds one for it', async () => {
  /* Given */
  const gone = path.join(tmp, 'gone');
  const again = path.join(tmp, 'again');
  run(repo, 'worktree', 'add', '-q', '-b', '121-gone', gone, 'main');
  commit(gone, 'e.txt', 'Earlier work');
  fs.rmSync(gone, { recursive: true, force: true });

  /* When */
  const pruned = await git.pruneWorktrees(repo);
  const added = await git.checkoutWorktree(repo, again, '121-gone');

  /* Then */
  assert.deepEqual(pruned, { ok: true });
  assert.deepEqual(added, { ok: true });
  assert.equal(await git.currentBranch(again), '121-gone');
  assert.equal(fs.existsSync(path.join(again, 'e.txt')), true);
});
