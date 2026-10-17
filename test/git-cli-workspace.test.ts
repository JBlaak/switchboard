import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitCliWorkspace, parseStatus, sumNumstat } from '../src/infrastructure/git/git-cli-workspace';
import { parseUnifiedDiff } from '../src/domain/session-work/diff';

// Keep the developer's own git config (signing, hooks, a diff tool) out of
// both the fixture and the adapter under test.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = os.devNull;

const git = new GitCliWorkspace();
let tmp: string;
let repo: string;
let worktree: string;

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function commit(dir: string, message: string): void {
  run(dir, 'add', '-A');
  run(dir, 'commit', '-q', '-m', message);
}

before(() => {
  // realpath: on macOS os.tmpdir() is behind a /var -> /private/var symlink,
  // and git answers with the real path.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-git-')));
  repo = path.join(tmp, 'repo');
  worktree = path.join(tmp, 'agent-wt');
  fs.mkdirSync(repo);
  run(repo, 'init', '-q', '-b', 'main');
  write(repo, 'a.txt', 'one\n');
  write(repo, 'b.txt', 'bee\n');
  write(repo, '.gitattributes', 'gen/** linguist-generated\n');
  commit(repo, 'Initial');

  run(repo, 'worktree', 'add', '-q', '-b', 'feat/12-thing', worktree, 'main');
  write(worktree, 'src/sub/feature.ts', 'export const feature = 1;\n');
  commit(worktree, 'Add the feature');
  write(worktree, 'gen/out.js', 'generated();\n');
  commit(worktree, 'Generate');

  write(repo, 'c.txt', 'main moved on\n');
  commit(repo, 'Move main');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('worktreeRoot resolves a subdirectory of a linked worktree to its root, and a non-repo to null', async () => {
  assert.equal(await git.worktreeRoot(path.join(worktree, 'src', 'sub')), worktree);
  assert.equal(await git.worktreeRoot(repo), repo);
  const outside = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(outside);
  assert.equal(await git.worktreeRoot(outside), null);
  assert.equal(await git.worktreeRoot(path.join(tmp, 'gone')), null);
});

test('defaultBranch falls back to main or master without origin/HEAD, and reads it when set', async () => {
  assert.equal(await git.defaultBranch(worktree), 'main');

  const legacy = path.join(tmp, 'legacy');
  fs.mkdirSync(legacy);
  run(legacy, 'init', '-q', '-b', 'master');
  write(legacy, 'x', 'x\n');
  commit(legacy, 'Initial');
  assert.equal(await git.defaultBranch(legacy), 'master');

  const clone = path.join(tmp, 'clone');
  run(tmp, 'clone', '-q', repo, clone);
  assert.equal(await git.defaultBranch(clone), 'main');
  run(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.equal(await git.defaultBranch(clone), 'trunk');
});

test('branchExists knows local branches and refuses option-like names', async () => {
  assert.equal(await git.branchExists(worktree, 'feat/12-thing'), true);
  assert.equal(await git.branchExists(repo, 'feat/12-thing'), true, 'branches are shared across worktrees');
  assert.equal(await git.branchExists(worktree, 'nope'), false);
  assert.equal(await git.branchExists(worktree, '--all'), false);
});

test('isPushed: a branch with an upstream, or one origin has, is pushed; a local-only one is not', async () => {
  const remote = path.join(tmp, 'pushed-remote.git');
  const clone = path.join(tmp, 'pushed-clone');
  run(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  fs.mkdirSync(clone);
  run(clone, 'init', '-q', '-b', 'main');
  run(clone, 'remote', 'add', 'origin', remote);
  write(clone, 'a.txt', 'a\n');
  commit(clone, 'Initial');

  run(clone, 'checkout', '-q', '-b', 'tracked');
  run(clone, 'push', '-q', '-u', 'origin', 'tracked');
  run(clone, 'checkout', '-q', '-b', 'copied');
  run(clone, 'push', '-q', 'origin', 'copied');
  run(clone, 'checkout', '-q', '-b', 'local-only');

  assert.equal(await git.isPushed(clone, 'tracked'), true, 'has an upstream');
  assert.equal(await git.isPushed(clone, 'copied'), true, 'origin has it, without tracking');
  assert.equal(await git.isPushed(clone, 'local-only'), false);
  assert.equal(await git.isPushed(clone, '--all'), false);
});

test('currentBranch and commitSha read HEAD and refs, and answer null for what is not there', async () => {
  assert.equal(await git.currentBranch(worktree), 'feat/12-thing');
  assert.equal(await git.currentBranch(repo), 'main');
  assert.equal(await git.currentBranch(path.join(tmp, 'gone')), null);
  assert.equal(await git.commitSha(repo, 'main'), run(repo, 'rev-parse', 'main').trim());
  assert.equal(await git.commitSha(repo, 'no-such-branch'), null);
  assert.equal(await git.commitSha(repo, '--all'), null);
});

test('aheadBehind counts both sides', async () => {
  assert.deepEqual(await git.aheadBehind(worktree, 'feat/12-thing', 'main'), { ahead: 2, behind: 1 });
  assert.deepEqual(await git.aheadBehind(worktree, 'nope', 'main'), { ahead: 0, behind: 0 });
});

test('branchDiff is taken from the merge-base, so what main gained since is not in it', async () => {
  const files = parseUnifiedDiff(await git.branchDiff(worktree, 'feat/12-thing', 'main'));
  assert.deepEqual(files.map((f) => [f.path, f.status]), [
    ['gen/out.js', 'added'],
    ['src/sub/feature.ts', 'added'],
  ]);
  assert.equal(await git.branchDiff(worktree, 'nope', 'main'), '');
});

test('branchLineStats counts the same lines as branchDiff, and zeros for what is not there', async () => {
  assert.deepEqual(await git.branchLineStats(worktree, 'feat/12-thing', 'main'), { additions: 2, deletions: 0 });
  assert.deepEqual(await git.branchLineStats(worktree, 'nope', 'main'), { additions: 0, deletions: 0 });
  assert.deepEqual(await git.branchLineStats(worktree, '--all', 'main'), { additions: 0, deletions: 0 });
});

test('sumNumstat adds up numstat lines, binary files counting nothing', () => {
  assert.deepEqual(sumNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\told => new\n'), { additions: 13, deletions: 1 });
  assert.deepEqual(sumNumstat(''), { additions: 0, deletions: 0 });
});

test('generatedPaths reads linguist-generated from .gitattributes', async () => {
  assert.deepEqual(await git.generatedPaths(worktree, ['gen/out.js', 'a.txt', 'src/sub/feature.ts']), ['gen/out.js']);
  assert.deepEqual(await git.generatedPaths(worktree, []), []);
});

test('status and workingDiff cover staged, unstaged, renamed and untracked changes', async () => {
  const dirty = path.join(tmp, 'dirty-wt');
  run(repo, 'worktree', 'add', '-q', '-b', 'feat/dirty', dirty, 'main');
  write(dirty, 'a.txt', 'one\ntwo\n');
  write(dirty, 'staged.txt', 'staged\n');
  run(dirty, 'add', 'staged.txt');
  run(dirty, 'mv', 'b.txt', 'b2.txt');
  write(dirty, 'notes/untracked.md', '# new\n');
  fs.rmSync(path.join(dirty, 'c.txt'));

  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  assert.deepEqual((await git.status(dirty)).sort(byPath), [
    { path: 'a.txt', status: 'modified' },
    { path: 'b2.txt', oldPath: 'b.txt', status: 'renamed' },
    { path: 'c.txt', status: 'deleted' },
    { path: 'notes/untracked.md', status: 'untracked' },
    { path: 'staged.txt', status: 'added' },
  ]);

  const files = parseUnifiedDiff(await git.workingDiff(dirty));
  assert.deepEqual(files.map((f) => [f.path, f.status]).sort(), [
    ['a.txt', 'modified'],
    ['b2.txt', 'renamed'],
    ['c.txt', 'deleted'],
    ['notes/untracked.md', 'added'],
    ['staged.txt', 'added'],
  ]);
  const untracked = files.find((f) => f.path === 'notes/untracked.md')!;
  assert.deepEqual(untracked.hunks[0].lines.map((l) => [l.kind, l.text]), [['add', '# new']]);

  // a.txt +1, staged.txt +1, c.txt −1, notes/untracked.md +1; the rename changed nothing.
  assert.deepEqual(await git.workingLineStats(dirty), { additions: 3, deletions: 1 });

  // Reading changed nothing: the file is still untracked.
  assert.match(run(dirty, 'status', '--porcelain', '--untracked-files=all'),/^\?\? notes\/untracked\.md$/m);
});

test('status and workingDiff leave out nested repositories, such as agent worktrees inside the checkout', async () => {
  const host = path.join(tmp, 'host');
  fs.mkdirSync(host);
  run(host, 'init', '-q', '-b', 'main');
  write(host, 'a.txt', 'one\n');
  commit(host, 'Initial');
  // An agent's worktree under the checkout, as Claude Code makes them, and a plain nested clone.
  run(host, 'worktree', 'add', '-q', '-b', 'agent-1', path.join(host, '.claude', 'worktrees', 'agent-1'), 'main');
  const nested = path.join(host, 'vendor', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  run(nested, 'init', '-q', '-b', 'main');
  write(nested, 'lib.txt', 'lib\n');
  write(host, 'loose.txt', 'loose\n');

  // git itself lists them, as directories.
  assert.match(run(host, 'status', '--porcelain', '--untracked-files=all'), /^\?\? \.claude\/worktrees\/agent-1\/$/m);

  assert.deepEqual(await git.status(host), [{ path: 'loose.txt', status: 'untracked' }]);
  const files = parseUnifiedDiff(await git.workingDiff(host));
  assert.deepEqual(files.map((f) => [f.path, f.status]), [['loose.txt', 'added']]);

  fs.rmSync(path.join(host, 'loose.txt'));
  assert.deepEqual(await git.status(host), [], 'a checkout with only nested repositories is clean');
  assert.equal(await git.workingDiff(host), '');
});

test('workingDiff works in a repository with no commits yet', async () => {
  const fresh = path.join(tmp, 'fresh');
  fs.mkdirSync(fresh);
  run(fresh, 'init', '-q', '-b', 'main');
  write(fresh, 'staged.txt', 's\n');
  run(fresh, 'add', 'staged.txt');
  write(fresh, 'loose.txt', 'l\n');
  const files = parseUnifiedDiff(await git.workingDiff(fresh));
  assert.deepEqual(files.map((f) => [f.path, f.status]).sort(), [['loose.txt', 'added'], ['staged.txt', 'added']]);
});

test('watch fires once a commit lands in a linked worktree, and not after dispose', async () => {
  // The linked worktree's git dir is `.git/worktrees/<name>`, not `.git`.
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile());

  let calls = 0;
  let fired!: () => void;
  const firedOnce = new Promise<void>((resolve) => { fired = resolve; });
  const handle = git.watch(worktree, () => { calls++; fired(); });
  try {
    // Give the watchers a moment to attach before writing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    write(worktree, 'later.txt', 'later\n');
    commit(worktree, 'Later');
    await Promise.race([
      firedOnce,
      new Promise((_, reject) => setTimeout(() => reject(new Error('watch did not fire')), 5_000)),
    ]);
  } finally {
    handle.dispose();
  }
  const seen = calls;
  write(worktree, 'after.txt', 'after\n');
  commit(worktree, 'After');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls, seen, 'nothing fires after dispose');
});

test('parseStatus reads porcelain v1 -z, including a rename\'s old path and names with spaces', () => {
  assert.deepEqual(parseStatus('R  new name.txt\0old name.txt\0 M a.txt\0?? b c.txt\0AM d.txt\0 D e.txt\0!! ignored\0?? .claude/worktrees/agent-1/\0'), [
    { path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed' },
    { path: 'a.txt', status: 'modified' },
    { path: 'b c.txt', status: 'untracked' },
    { path: 'd.txt', status: 'added' },
    { path: 'e.txt', status: 'deleted' },
  ]);
});
