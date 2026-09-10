import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BrowseService } from '../src/application/services/browse-service';
import { fakeFileSystem, fakeProcessRunner, silentLog } from './support/fakes';
import type { ExecResult } from '../src/application/ports/process-runner';

/**
 * The tree is read through the ports, so these assert on two things: what the
 * service asked git for, and what it made of the answer. No repository is
 * created and no ssh connection is made — the interesting part is the reading
 * of an exit code, and `check-ignore` says three different things with three
 * different codes.
 */

const exit = (code: number, stdout = '', stderr = ''): ExecResult => ({ stdout, stderr, code });

/**
 * A `git check-ignore` in a repository that ignores `ignored` — which, when
 * that is nothing, is exit 1 rather than empty output.
 */
const ignoring = (...ignored: string[]): ExecResult =>
  (ignored.length ? exit(0, ignored.join('\0') + '\0') : exit(1));

const WORKTREE = '/home/test/proj';

/**
 * A service over an in-memory tree and a scripted runner.
 *
 * `answer` decides what every spawned command reports, which for a local
 * listing is only ever `git check-ignore`.
 */
function harness(
  seed: { files?: Record<string, string>; dirs?: string[]; links?: string[] } = {},
  answer: (file: string, args: readonly string[], stdin?: string) => ExecResult | undefined =
    () => ignoring(),
) {
  const fs = fakeFileSystem(seed);
  const runner = fakeProcessRunner(answer);
  const browse = new BrowseService({ fs, runner, log: silentLog });
  return { fs, runner, browse };
}

const names = (listing: { entries: { name: string }[] }): string[] => listing.entries.map(e => e.name);

// --- Listing ---

test('a listing is directories first, then case-insensitively by name', async () => {
  const h = harness({
    files: {
      [`${WORKTREE}/README.md`]: '', [`${WORKTREE}/apple.ts`]: '', [`${WORKTREE}/Banana.ts`]: '',
      [`${WORKTREE}/src/index.ts`]: '', [`${WORKTREE}/Docs/guide.md`]: '',
    },
  });

  const listing = await h.browse.listDir(WORKTREE, '');

  assert.deepEqual(names(listing), ['Docs', 'src', 'apple.ts', 'Banana.ts', 'README.md']);
  assert.equal(listing.unreadable, undefined);
  assert.deepEqual(listing.entries[0], { name: 'Docs', isDirectory: true, isSymbolicLink: false });
});

test('every name in the directory is offered to git in one spawn, NUL-separated', async () => {
  const h = harness({ files: { [`${WORKTREE}/a.ts`]: '', [`${WORKTREE}/b.ts`]: '' } });
  await h.browse.listDir(WORKTREE, '');

  assert.equal(h.runner.calls.length, 1, 'one check-ignore per listing, whatever the directory holds');
  const [call] = h.runner.calls;
  assert.equal(call.file, 'git');
  assert.deepEqual(call.args.slice(-5), ['-C', WORKTREE, 'check-ignore', '-z', '--stdin']);
  assert.deepEqual(call.opts.stdin?.split('\0').sort(), ['a.ts', 'b.ts']);
  assert.equal(call.opts.env?.GIT_OPTIONAL_LOCKS, '0', 'never take the index lock from a running agent');
});

test('a name git reports as ignored is dropped', async () => {
  const h = harness(
    { files: { [`${WORKTREE}/index.ts`]: '', [`${WORKTREE}/dist/bundle.js`]: '', [`${WORKTREE}/.env`]: '' } },
    () => ignoring('dist', '.env'),
  );

  assert.deepEqual(names(await h.browse.listDir(WORKTREE, '')), ['index.ts']);
});

test('exit 1 is git saying nothing matched, so nothing is dropped', async () => {
  const h = harness(
    { files: { [`${WORKTREE}/index.ts`]: '', [`${WORKTREE}/node_modules/left-pad/index.js`]: '' } },
    () => exit(1),
  );

  // node_modules survives: inside a repository the .gitignore files decide,
  // and a project that checks its dependencies in should see them.
  assert.deepEqual(names(await h.browse.listDir(WORKTREE, '')), ['node_modules', 'index.ts']);
});

test('exit 128 — not a repository — falls back to hiding .git and node_modules', async () => {
  const h = harness(
    {
      files: { [`${WORKTREE}/notes.md`]: '' },
      dirs: [`${WORKTREE}/.git`, `${WORKTREE}/node_modules`, `${WORKTREE}/src`],
    },
    () => exit(128, '', 'fatal: not a git repository (or any of the parent directories): .git\n'),
  );

  assert.deepEqual(names(await h.browse.listDir(WORKTREE, '')), ['src', 'notes.md']);
});

test('.git is never listed, repository or not', async () => {
  const h = harness({ files: { [`${WORKTREE}/a.ts`]: '' }, dirs: [`${WORKTREE}/.git`] });

  // git does not report .git as ignored — it does not consider it a path at
  // all — so the listing has to drop it itself.
  assert.deepEqual(names(await h.browse.listDir(WORKTREE, '')), ['a.ts']);
});

test('git being missing altogether does not stop the tree being read', async () => {
  const h = harness(
    { files: { [`${WORKTREE}/a.ts`]: '' }, dirs: [`${WORKTREE}/node_modules`] },
    () => { throw new Error('git could not be started: spawn git ENOENT'); },
  );

  assert.deepEqual(names(await h.browse.listDir(WORKTREE, '')), ['a.ts']);
});

test('one level only: a subdirectory is a name, not a subtree', async () => {
  const h = harness({ files: { [`${WORKTREE}/src/deep/deeper/leaf.ts`]: '' } });

  assert.deepEqual(names(await h.browse.listDir(WORKTREE, '')), ['src']);
  assert.deepEqual(names(await h.browse.listDir(WORKTREE, 'src')), ['deep']);
  assert.equal(h.runner.calls[1].args.at(-4), `${WORKTREE}/src`, 'ignore rules are asked about there, too');
});

test('a symlinked directory is a leaf: listed, marked, and not followed', async () => {
  const h = harness({
    files: { [`${WORKTREE}/src/index.ts`]: '' },
    links: [`${WORKTREE}/vendor`],
  });

  const listing = await h.browse.listDir(WORKTREE, '');
  assert.deepEqual(listing.entries, [
    { name: 'src', isDirectory: true, isSymbolicLink: false },
    { name: 'vendor', isDirectory: false, isSymbolicLink: true },
  ]);
});

test('a path that leaves the worktree is refused before anything is read', async () => {
  const h = harness({ files: { [`${WORKTREE}/a.ts`]: '', '/home/test/.ssh/id_rsa': 'secret' } });

  await assert.rejects(h.browse.listDir(WORKTREE, '../.ssh'), /leaves the project/);
  await assert.rejects(h.browse.listDir(WORKTREE, 'src/../../.ssh'), /leaves the project/);
  await assert.rejects(h.browse.readFile(WORKTREE, '../.ssh/id_rsa'), /leaves the project/);
  assert.equal(h.runner.calls.length, 0, 'nothing was run');
});

test('a leading slash names the worktree root rather than the disk', async () => {
  const h = harness({ files: { [`${WORKTREE}/src/index.ts`]: '' } });

  assert.deepEqual(names(await h.browse.listDir(WORKTREE, '/src')), ['index.ts']);
});

test('a directory that cannot be read is empty and says so, rather than throwing', async () => {
  const h = harness({ files: { [`${WORKTREE}/a.ts`]: '' } });

  const listing = await h.browse.listDir(WORKTREE, 'gone');
  assert.deepEqual(listing.entries, []);
  assert.equal(listing.unreadable, true);
  // The reason travels with the answer: the tab prints it rather than showing
  // an empty folder, which would be a different claim about the same directory.
  assert.match(listing.error ?? '', /ENOENT/);
  assert.equal(h.runner.calls.length, 0, 'there was nothing to ask git about');
});

// --- Reading a file ---

test('a local file comes back as text, writable', async () => {
  const h = harness({ files: { [`${WORKTREE}/src/index.ts`]: 'export const x = 1;\n' } });

  assert.deepEqual(await h.browse.readFile(WORKTREE, 'src/index.ts'), { content: 'export const x = 1;\n' });
});

test('a file that is not there is an error the tab can print, not a rejection', async () => {
  const h = harness({ dirs: [WORKTREE] });

  const result = await h.browse.readFile(WORKTREE, 'src/index.ts');
  assert.match(result.error ?? '', /ENOENT/);
  assert.equal(result.content, undefined);
});

test('a file past the size limit is refused instead of pushed through IPC', async () => {
  const h = harness({ files: { [`${WORKTREE}/huge.log`]: 'x'.repeat(3 * 1024 * 1024) } });

  const result = await h.browse.readFile(WORKTREE, 'huge.log');
  assert.equal(result.content, undefined);
  assert.match(result.error ?? '', /3\.0 MB.*too large/);
  assert.match(result.error ?? '', /the limit is 2\.0 MB/);
});

// --- Remote ---

const REMOTE = 'ssh://joris@10.10.0.24/srv/app';

test('a remote listing runs ls on the far host and reads the trailing slash as a directory', async () => {
  const h = harness({}, (file, args) => {
    if (file !== 'ssh') return undefined;
    const command = args[args.length - 1];
    if (command.includes("'ls'")) return exit(0, 'src/\nnode_modules/\nREADME.md\n.env\n');
    return ignoring('node_modules', '.env');
  });

  const listing = await h.browse.listDir(REMOTE, '');

  assert.deepEqual(listing.entries, [
    { name: 'src', isDirectory: true, isSymbolicLink: false },
    // No symlink information in `ls -1Ap` output — a remote listing cannot
    // tell a link from what it points at.
    { name: 'README.md', isDirectory: false, isSymbolicLink: false },
  ]);

  assert.equal(h.runner.calls.length, 2, 'one ls, then one check-ignore');
  const [list, ignore] = h.runner.calls;
  assert.equal(list.file, 'ssh');
  assert.ok(list.args.includes('BatchMode=yes'), 'nobody is there to answer a prompt');
  assert.ok(list.args.includes('joris@10.10.0.24'));
  assert.equal(list.args.at(-1), "'ls' '-1Ap' '--' 'srv/app'");
  assert.equal(list.opts.timeoutMs, 30_000, 'the bound also covers the ssh handshake');
  // The far git is asked the same question, in the same directory: relative to
  // the login home, which is where sshd starts a one-shot command.
  assert.equal(ignore.file, 'ssh');
  const ignoreCommand = ignore.args.at(-1) ?? '';
  assert.ok(ignoreCommand.includes("'-C' 'srv/app' 'check-ignore' '-z' '--stdin'"), ignoreCommand);
  assert.deepEqual(ignore.opts.stdin?.split('\0').sort(), ['.env', 'README.md', 'node_modules', 'src']);
});

test('a remote directory that ls cannot read is unreadable, and git is not asked', async () => {
  const h = harness({}, () => exit(2, '', "ls: cannot access 'srv/app/gone': No such file or directory\n"));

  assert.deepEqual(await h.browse.listDir(REMOTE, 'gone'), {
    entries: [],
    unreadable: true,
    error: "ls: cannot access 'srv/app/gone': No such file or directory",
  });
  assert.equal(h.runner.calls.length, 1);
});

test('a host that cannot be reached says so, so the tab never calls it an empty folder', async () => {
  // What ssh prints under BatchMode=yes when there is no key it can use. The
  // exit code is ssh's own, not `ls`'s: the command never ran at all.
  const h = harness({}, () => exit(255, '', 'user@host: Permission denied (publickey).\n'));

  const listing = await h.browse.listDir(REMOTE, '');
  assert.deepEqual(listing.entries, []);
  assert.equal(listing.unreadable, true);
  assert.equal(listing.error, 'user@host: Permission denied (publickey).');
});

test('a remote read is marked read-only, because there is no way to write it back', async () => {
  const h = harness({}, () => exit(0, 'export const x = 1;\n'));

  const result = await h.browse.readFile(REMOTE, 'src/index.ts');
  assert.deepEqual(result, { content: 'export const x = 1;\n', readOnly: true });
  const command = h.runner.calls[0].args.at(-1) ?? '';
  assert.ok(command.includes("'srv/app/src/index.ts'"), command);
  assert.ok(command.includes('wc -c'), 'the size is measured on the far side, before anything is sent');
});

test('a remote file past the limit is refused by the far side, so the bytes never cross', async () => {
  const h = harness({}, () => exit(3, '', '5242880\n'));

  const result = await h.browse.readFile(REMOTE, 'huge.log');
  assert.equal(result.content, undefined);
  assert.match(result.error ?? '', /5\.0 MB.*too large/);
});

test('a remote project with no directory of its own reads the login home', async () => {
  const h = harness({}, () => exit(0, 'src/\n'));

  await h.browse.listDir('ssh://joris@host', '');
  assert.equal(h.runner.calls[0].args.at(-1), "'ls' '-1Ap' '--' '.'");
});

test('a malformed remote path is a bug that names itself', async () => {
  const h = harness();

  await assert.rejects(h.browse.listDir('ssh://nonsense', ''), /not a valid remote project path/);
  assert.equal(h.runner.calls.length, 0);
});
