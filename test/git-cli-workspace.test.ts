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

test('worktreeRoot resolves a subdirectory of a linked worktree to its root', async () => {
  /* When */
  const root = await git.worktreeRoot(path.join(worktree, 'src', 'sub'));

  /* Then */
  assert.equal(root, worktree);
});

test('worktreeRoot resolves the main checkout to itself', async () => {
  /* When */
  const root = await git.worktreeRoot(repo);

  /* Then */
  assert.equal(root, repo);
});

test('worktreeRoot resolves a non-repo to null', async () => {
  /* Given */
  const outside = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(outside);

  /* When */
  const outsideRoot = await git.worktreeRoot(outside);
  const goneRoot = await git.worktreeRoot(path.join(tmp, 'gone'));

  /* Then */
  assert.equal(outsideRoot, null);
  assert.equal(goneRoot, null);
});

test('defaultBranch falls back to main without origin/HEAD', async () => {
  /* When */
  const branch = await git.defaultBranch(worktree);

  /* Then */
  assert.equal(branch, 'main');
});

test('defaultBranch falls back to master without origin/HEAD', async () => {
  /* Given */
  const legacy = path.join(tmp, 'legacy');
  fs.mkdirSync(legacy);
  run(legacy, 'init', '-q', '-b', 'master');
  write(legacy, 'x', 'x\n');
  commit(legacy, 'Initial');

  /* When */
  const branch = await git.defaultBranch(legacy);

  /* Then */
  assert.equal(branch, 'master');
});

test('defaultBranch reads origin/HEAD in a clone', async () => {
  /* Given */
  const clone = path.join(tmp, 'clone');
  run(tmp, 'clone', '-q', repo, clone);

  /* When */
  const branch = await git.defaultBranch(clone);

  /* Then */
  assert.equal(branch, 'main');
});

test('defaultBranch follows origin/HEAD when it is set to another branch', async () => {
  /* Given */
  const clone = path.join(tmp, 'clone-trunk');
  run(tmp, 'clone', '-q', repo, clone);
  run(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

  /* When */
  const branch = await git.defaultBranch(clone);

  /* Then */
  assert.equal(branch, 'trunk');
});

test('branchExists knows local branches, across worktrees', async () => {
  /* When */
  const inWorktree = await git.branchExists(worktree, 'feat/12-thing');
  const inMain = await git.branchExists(repo, 'feat/12-thing');

  /* Then */
  assert.equal(inWorktree, true);
  assert.equal(inMain, true, 'branches are shared across worktrees');
});

test('branchExists does not know a branch that is not there', async () => {
  /* When */
  const exists = await git.branchExists(worktree, 'nope');

  /* Then */
  assert.equal(exists, false);
});

test('branchExists refuses option-like names', async () => {
  /* When */
  const exists = await git.branchExists(worktree, '--all');

  /* Then */
  assert.equal(exists, false);
});

test('isPushed: a branch with an upstream, or one origin has, is pushed; a local-only one is not', async () => {
  /* Given */
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

  /* When */
  const tracked = await git.isPushed(clone, 'tracked');
  const copied = await git.isPushed(clone, 'copied');
  const localOnly = await git.isPushed(clone, 'local-only');
  const optionLike = await git.isPushed(clone, '--all');

  /* Then */
  assert.equal(tracked, true, 'has an upstream');
  assert.equal(copied, true, 'origin has it, without tracking');
  assert.equal(localOnly, false);
  assert.equal(optionLike, false);
});

test('currentBranch reads HEAD, and answers null for what is not there', async () => {
  /* When */
  const inWorktree = await git.currentBranch(worktree);
  const inMain = await git.currentBranch(repo);
  const gone = await git.currentBranch(path.join(tmp, 'gone'));

  /* Then */
  assert.equal(inWorktree, 'feat/12-thing');
  assert.equal(inMain, 'main');
  assert.equal(gone, null);
});

test('commitSha reads refs, and answers null for what is not there', async () => {
  /* When */
  const main = await git.commitSha(repo, 'main');
  const missing = await git.commitSha(repo, 'no-such-branch');
  const optionLike = await git.commitSha(repo, '--all');

  /* Then */
  assert.equal(main, run(repo, 'rev-parse', 'main').trim());
  assert.equal(missing, null);
  assert.equal(optionLike, null);
});

test('aheadBehind counts both sides', async () => {
  /* When */
  const counts = await git.aheadBehind(worktree, 'feat/12-thing', 'main');

  /* Then */
  assert.deepEqual(counts, { ahead: 2, behind: 1 });
});

test('aheadBehind counts nothing for a branch that is not there', async () => {
  /* When */
  const counts = await git.aheadBehind(worktree, 'nope', 'main');

  /* Then */
  assert.deepEqual(counts, { ahead: 0, behind: 0 });
});

test('branchDiff is taken from the merge-base, so what main gained since is not in it', async () => {
  /* When */
  const diff = await git.branchDiff(worktree, 'feat/12-thing', 'main');

  /* Then */
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [
    ['gen/out.js', 'added'],
    ['src/sub/feature.ts', 'added'],
  ]);
});

test('branchDiff is empty for a branch that is not there', async () => {
  /* When */
  const diff = await git.branchDiff(worktree, 'nope', 'main');

  /* Then */
  assert.equal(diff, '');
});

test('branchLineStats counts the same lines as branchDiff', async () => {
  /* When */
  const stats = await git.branchLineStats(worktree, 'feat/12-thing', 'main');

  /* Then */
  assert.deepEqual(stats, { additions: 2, deletions: 0 });
});

test('branchLineStats counts zeros for what is not there', async () => {
  /* When */
  const missing = await git.branchLineStats(worktree, 'nope', 'main');
  const optionLike = await git.branchLineStats(worktree, '--all', 'main');

  /* Then */
  assert.deepEqual(missing, { additions: 0, deletions: 0 });
  assert.deepEqual(optionLike, { additions: 0, deletions: 0 });
});

test('mergeBase is the commit the branch forked from, not where main is now', async () => {
  /* When */
  const base = await git.mergeBase(worktree, 'feat/12-thing', 'main');

  /* Then */
  assert.equal(base, run(repo, 'rev-parse', 'main~1').trim());
});

test('mergeBase answers null for a branch that is not there, or an option-like one', async () => {
  /* When */
  const missing = await git.mergeBase(worktree, 'nope', 'main');
  const optionLike = await git.mergeBase(worktree, '--all', 'main');

  /* Then */
  assert.equal(missing, null);
  assert.equal(optionLike, null);
});

/** Not valid UTF-8, with NULs and a CR-LF in it: bytes that must come through untouched. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe, 0x80]);

let images: string | undefined;

/** A repository with images in two commits and a changed working tree; made once, only ever read. */
function imageRepo(): { dir: string; first: string } {
  if (!images) {
    images = path.join(tmp, 'images');
    fs.mkdirSync(images);
    run(images, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(images, 'logo.png'), PNG_BYTES);
    write(images, 'art/with space.svg', '<svg/>\n');
    commit(images, 'Add images');
    write(images, 'art/with space.svg', '<svg></svg>\n');
    commit(images, 'Change the svg');
    fs.writeFileSync(path.join(images, 'logo.png'), Buffer.concat([PNG_BYTES, PNG_BYTES]));
    write(images, 'new.png', 'new');
    fs.symlinkSync(path.join(tmp, 'outside.png'), path.join(images, 'link.png'));
    write(tmp, 'outside.png', 'outside the worktree');
  }
  return { dir: images, first: run(images, 'rev-parse', 'HEAD~1').trim() };
}

test('blobSizes sizes each path at a revision in one go, leaving out what is not there', async () => {
  /* Given */
  const { dir, first } = imageRepo();

  /* When */
  const atHead = await git.blobSizes(dir, 'HEAD', ['logo.png', 'art/with space.svg', 'new.png', 'art']);
  const atFirst = await git.blobSizes(dir, first, ['art/with space.svg']);

  /* Then */
  assert.deepEqual([...atHead], [['logo.png', PNG_BYTES.length], ['art/with space.svg', 12]], 'new.png is not committed, art is a tree');
  assert.deepEqual([...atFirst], [['art/with space.svg', 7]]);
});

test('blobSizes of nothing, or at an option-like revision, is empty', async () => {
  /* Given */
  const { dir } = imageRepo();

  /* When */
  const none = await git.blobSizes(dir, 'HEAD', []);
  const optionLike = await git.blobSizes(dir, '--all', ['logo.png']);

  /* Then */
  assert.equal(none.size, 0);
  assert.equal(optionLike.size, 0);
});

test('blob answers the committed bytes untouched', async () => {
  /* Given */
  const { dir, first } = imageRepo();

  /* When */
  const logo = await git.blob(dir, 'HEAD', 'logo.png');
  const svg = await git.blob(dir, first, 'art/with space.svg');

  /* Then */
  assert.deepEqual(Buffer.from(logo!), PNG_BYTES);
  assert.equal(Buffer.from(svg!).toString('utf8'), '<svg/>\n');
});

test('blob answers null for what is not there', async () => {
  /* Given */
  const { dir } = imageRepo();

  /* When */
  const missing = await git.blob(dir, 'HEAD', 'new.png');
  const noRevision = await git.blob(dir, 'no-such-branch', 'logo.png');
  const optionLike = await git.blob(dir, '--all', 'logo.png');

  /* Then */
  assert.equal(missing, null);
  assert.equal(noRevision, null);
  assert.equal(optionLike, null);
});

test('workingFile and workingFileSizes read the file on disk', async () => {
  /* Given */
  const { dir } = imageRepo();

  /* When */
  const sizes = await git.workingFileSizes(dir, ['logo.png', 'new.png', 'gone.png']);
  const logo = await git.workingFile(dir, 'logo.png');

  /* Then */
  assert.deepEqual([...sizes], [['logo.png', PNG_BYTES.length * 2], ['new.png', 3]]);
  assert.deepEqual(Buffer.from(logo!), Buffer.concat([PNG_BYTES, PNG_BYTES]));
});

test('workingFile never reads outside the worktree, nor through a symlink', async () => {
  /* Given */
  const { dir } = imageRepo();
  const escapes = ['../outside.png', path.join(tmp, 'outside.png'), 'link.png', 'art', ''];

  /* When */
  const read = await Promise.all(escapes.map((file) => git.workingFile(dir, file)));
  const sizes = await git.workingFileSizes(dir, escapes);

  /* Then */
  assert.deepEqual(read, escapes.map(() => null));
  assert.equal(sizes.size, 0);
});

test('sumNumstat adds up numstat lines, binary files counting nothing', () => {
  /* When */
  const sum = sumNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\told => new\n');

  /* Then */
  assert.deepEqual(sum, { additions: 13, deletions: 1 });
});

test('sumNumstat of nothing is zero', () => {
  /* When */
  const sum = sumNumstat('');

  /* Then */
  assert.deepEqual(sum, { additions: 0, deletions: 0 });
});

test('generatedPaths reads linguist-generated from .gitattributes', async () => {
  /* When */
  const generated = await git.generatedPaths(worktree, ['gen/out.js', 'a.txt', 'src/sub/feature.ts']);

  /* Then */
  assert.deepEqual(generated, ['gen/out.js']);
});

test('generatedPaths of no paths is none', async () => {
  /* When */
  const generated = await git.generatedPaths(worktree, []);

  /* Then */
  assert.deepEqual(generated, []);
});

let dirty: string | undefined;

/** A worktree with staged, unstaged, renamed, deleted and untracked changes; made once, only ever read. */
function dirtyWorktree(): string {
  if (dirty) return dirty;
  dirty = path.join(tmp, 'dirty-wt');
  run(repo, 'worktree', 'add', '-q', '-b', 'feat/dirty', dirty, 'main');
  write(dirty, 'a.txt', 'one\ntwo\n');
  write(dirty, 'staged.txt', 'staged\n');
  run(dirty, 'add', 'staged.txt');
  run(dirty, 'mv', 'b.txt', 'b2.txt');
  write(dirty, 'notes/untracked.md', '# new\n');
  fs.rmSync(path.join(dirty, 'c.txt'));
  return dirty;
}

test('status covers staged, unstaged, renamed and untracked changes', async () => {
  /* Given */
  const dir = dirtyWorktree();
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);

  /* When */
  const status = await git.status(dir);

  /* Then */
  assert.deepEqual(status.sort(byPath), [
    { path: 'a.txt', status: 'modified' },
    { path: 'b2.txt', oldPath: 'b.txt', status: 'renamed' },
    { path: 'c.txt', status: 'deleted' },
    { path: 'notes/untracked.md', status: 'untracked' },
    { path: 'staged.txt', status: 'added' },
  ]);
});

test('workingDiff covers staged, unstaged, renamed and untracked changes', async () => {
  /* Given */
  const dir = dirtyWorktree();

  /* When */
  const diff = await git.workingDiff(dir);

  /* Then */
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((f) => [f.path, f.status]).sort(), [
    ['a.txt', 'modified'],
    ['b2.txt', 'renamed'],
    ['c.txt', 'deleted'],
    ['notes/untracked.md', 'added'],
    ['staged.txt', 'added'],
  ]);
  const untracked = files.find((f) => f.path === 'notes/untracked.md')!;
  assert.deepEqual(untracked.hunks[0].lines.map((l) => [l.kind, l.text]), [['add', '# new']]);
});

test('workingLineStats counts the working changes, a rename counting nothing', async () => {
  /* Given */
  const dir = dirtyWorktree();

  /* When */
  const stats = await git.workingLineStats(dir);

  /* Then */
  // a.txt +1, staged.txt +1, c.txt −1, notes/untracked.md +1; the rename changed nothing.
  assert.deepEqual(stats, { additions: 3, deletions: 1 });
});

test('reading the working changes changes nothing', async () => {
  /* Given */
  const dir = dirtyWorktree();

  /* When */
  await git.status(dir);
  await git.workingDiff(dir);
  await git.workingLineStats(dir);

  /* Then */
  // Reading changed nothing: the file is still untracked.
  assert.match(run(dir, 'status', '--porcelain', '--untracked-files=all'), /^\?\? notes\/untracked\.md$/m);
});

/** A checkout with nested repositories inside it, and one loose file. */
function hostWithNestedRepos(name: string): string {
  const host = path.join(tmp, name);
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
  return host;
}

test('status and workingDiff leave out nested repositories, such as agent worktrees inside the checkout', async () => {
  /* Given */
  const host = hostWithNestedRepos('host');

  /* When */
  const status = await git.status(host);
  const diff = await git.workingDiff(host);

  /* Then */
  // git itself lists them, as directories.
  assert.match(run(host, 'status', '--porcelain', '--untracked-files=all'), /^\?\? \.claude\/worktrees\/agent-1\/$/m);
  assert.deepEqual(status, [{ path: 'loose.txt', status: 'untracked' }]);
  assert.deepEqual(parseUnifiedDiff(diff).map((f) => [f.path, f.status]), [['loose.txt', 'added']]);
});

test('a checkout with only nested repositories is clean', async () => {
  /* Given */
  const host = hostWithNestedRepos('host-clean');
  fs.rmSync(path.join(host, 'loose.txt'));

  /* When */
  const status = await git.status(host);
  const diff = await git.workingDiff(host);

  /* Then */
  assert.deepEqual(status, [], 'a checkout with only nested repositories is clean');
  assert.equal(diff, '');
});

test('workingDiff works in a repository with no commits yet', async () => {
  /* Given */
  const fresh = path.join(tmp, 'fresh');
  fs.mkdirSync(fresh);
  run(fresh, 'init', '-q', '-b', 'main');
  write(fresh, 'staged.txt', 's\n');
  run(fresh, 'add', 'staged.txt');
  write(fresh, 'loose.txt', 'l\n');

  /* When */
  const diff = await git.workingDiff(fresh);

  /* Then */
  const files = parseUnifiedDiff(diff);
  assert.deepEqual(files.map((f) => [f.path, f.status]).sort(), [['loose.txt', 'added'], ['staged.txt', 'added']]);
});

test('watch fires once a commit lands in a linked worktree, and not after dispose', async () => {
  // A journey: firing and then disposing the same watch.
  /* Given */
  let calls = 0;
  let fired!: () => void;
  const firedOnce = new Promise<void>((resolve) => { fired = resolve; });
  const handle = git.watch(worktree, () => { calls++; fired(); });
  let seen: number;
  try {
    // Give the watchers a moment to attach before writing.
    await new Promise((resolve) => setTimeout(resolve, 100));

    /* When */
    write(worktree, 'later.txt', 'later\n');
    commit(worktree, 'Later');

    /* Then */
    await Promise.race([
      firedOnce,
      new Promise((_, reject) => setTimeout(() => reject(new Error('watch did not fire')), 5_000)),
    ]);
    // The linked worktree's git dir is `.git/worktrees/<name>`, not `.git`.
    assert.ok(fs.statSync(path.join(worktree, '.git')).isFile());
  } finally {
    handle.dispose();
    seen = calls;
  }

  /* When */
  write(worktree, 'after.txt', 'after\n');
  commit(worktree, 'After');
  await new Promise((resolve) => setTimeout(resolve, 300));

  /* Then */
  assert.equal(calls, seen, 'nothing fires after dispose');
});

test('parseStatus reads porcelain v1 -z, including a rename\'s old path and names with spaces', () => {
  /* Given */
  const porcelain = 'R  new name.txt\0old name.txt\0 M a.txt\0?? b c.txt\0AM d.txt\0 D e.txt\0!! ignored\0?? .claude/worktrees/agent-1/\0';

  /* When */
  const entries = parseStatus(porcelain);

  /* Then */
  assert.deepEqual(entries, [
    { path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed' },
    { path: 'a.txt', status: 'modified' },
    { path: 'b c.txt', status: 'untracked' },
    { path: 'd.txt', status: 'added' },
    { path: 'e.txt', status: 'deleted' },
  ]);
});
