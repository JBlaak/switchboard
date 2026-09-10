import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GitService } from '../src/application/services/git-service';
import { fakeFileSystem, fakeProcessRunner, silentLog } from './support/fakes';
import type { ExecResult, ProcessRunner } from '../src/application/ports/process-runner';

/**
 * The service decides where git runs and what its exit code means; the runner
 * is scripted, so these assert on the command that was asked for and on the
 * reading of the answer, never on a real repository.
 */

/** A main checkout and one linked worktree, as `git worktree list --porcelain` prints them. */
const PORCELAIN = [
  'worktree /Users/j/dev/proj',
  'HEAD 0123456789abcdef0123456789abcdef01234567',
  'branch refs/heads/main',
  '',
  'worktree /Users/j/dev/proj-feat',
  'HEAD 89abcdef0123456789abcdef0123456789abcdef',
  'branch refs/heads/feat/x',
  '',
].join('\n');

const exit = (code: number, stdout = '', stderr = ''): ExecResult => ({ stdout, stderr, code });

/** A service over a runner that answers every command with `answer`. */
function harness(answer: ExecResult = exit(0, PORCELAIN)) {
  const runner = fakeProcessRunner(() => answer);
  const git = new GitService({ runner, log: silentLog });
  return { runner, git };
}

/** The quoted `-C` argument of a remote command line. */
const remoteDirOf = (command: string): string | undefined => /'-C' '([^']*)'/.exec(command)?.[1];

// --- Local ---

test('a local project runs git here, targeted with -C rather than a cwd', async () => {
  const h = harness();
  await h.git.worktrees('/Users/j/dev/proj');

  assert.equal(h.runner.calls.length, 1);
  const [call] = h.runner.calls;
  assert.equal(call.file, 'git');
  assert.deepEqual(call.args.slice(-5), ['-C', '/Users/j/dev/proj', 'worktree', 'list', '--porcelain']);
  assert.equal(call.opts.cwd, undefined, 'the directory travels in the argv so the same command works over ssh');
  assert.equal(call.opts.env?.GIT_OPTIONAL_LOCKS, '0', 'never take the index lock from under a running agent');
  assert.equal(call.opts.timeoutMs, 15_000);
});

test('the porcelain output parses into the primary and the linked worktree', async () => {
  const h = harness();
  const worktrees = await h.git.worktrees('/Users/j/dev/proj');

  assert.deepEqual(worktrees, [
    {
      path: '/Users/j/dev/proj',
      head: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      isPrimary: true,
      detached: false,
    },
    {
      path: '/Users/j/dev/proj-feat',
      head: '89abcdef0123456789abcdef0123456789abcdef',
      branch: 'feat/x',
      isPrimary: false,
      detached: false,
    },
  ]);
});

test('a folder that is not a repository has no worktrees rather than an error', async () => {
  const h = harness(exit(128, '', 'fatal: not a git repository (or any of the parent directories): .git\n'));
  assert.deepEqual(await h.git.worktrees('/Users/j/notes'), []);
});

test('any other failure is thrown with what git said', async () => {
  const h = harness(exit(1, '', 'error: could not lock config file .git/config: Permission denied\n'));
  await assert.rejects(h.git.worktrees('/Users/j/dev/proj'), /could not lock config file/);
});

test('a failure that says nothing on stderr still names the exit code', async () => {
  const h = harness(exit(3));
  await assert.rejects(h.git.worktrees('/Users/j/dev/proj'), /exited with code 3/);
});

test('a runner rejection — git missing, the timeout — propagates untouched', async () => {
  const runner: ProcessRunner = {
    exec: async () => { throw new Error('git could not be started: spawn git ENOENT'); },
  };
  const git = new GitService({ runner, log: silentLog });
  await assert.rejects(git.worktrees('/Users/j/dev/proj'), /spawn git ENOENT/);
});

// --- Remote ---

test('a remote project runs the same git command on the far host over ssh', async () => {
  const h = harness();
  await h.git.worktrees('ssh://joris@10.10.0.24:22/srv/app');

  assert.equal(h.runner.calls.length, 1);
  const [call] = h.runner.calls;
  assert.equal(call.file, 'ssh');
  assert.ok(call.args.includes('BatchMode=yes'), 'nobody is there to answer a prompt');
  assert.ok(call.args.includes('joris@10.10.0.24'));
  assert.ok(!call.args.includes('-p'), 'the default port is left to ssh');
  // ssh hands the far shell one string, each argument quoted for it.
  const command = call.args[call.args.length - 1];
  assert.ok(command.includes("'worktree' 'list' '--porcelain'"), command);
  assert.equal(call.opts.cwd, undefined);
  assert.equal(call.opts.timeoutMs, 30_000, 'the bound also covers the ssh handshake');
});

test('a remote directory is named relative to the login home, which is where sshd starts a command', async () => {
  const dirOf = async (projectPath: string): Promise<string | undefined> => {
    const h = harness();
    await h.git.worktrees(projectPath);
    return remoteDirOf(h.runner.calls[0].args[h.runner.calls[0].args.length - 1]);
  };

  // `ssh://user@host/srv/app` is what adding `srv/app` next to user@host stores:
  // a directory under the login home, the same reading the interactive session gives it.
  assert.equal(await dirOf('ssh://joris@host/srv/app'), 'srv/app');
  assert.equal(await dirOf('ssh://joris@host//srv/app'), '/srv/app', 'an absolute directory is kept as-is');
  assert.equal(await dirOf('ssh://joris@host/~/dev/app'), 'dev/app', '`~` cannot expand inside the quoting, so it goes');
  assert.equal(await dirOf('ssh://joris@host'), '.', 'no directory means the login home itself');
});

test('a malformed remote path is a bug that names itself, not an empty repository', async () => {
  const h = harness();
  await assert.rejects(h.git.worktrees('ssh://nonsense'), /not a valid remote project path/);
  assert.equal(h.runner.calls.length, 0, 'nothing was run');
});

test('a remote failure is thrown with what ssh or the far git said', async () => {
  const h = harness(exit(255, '', 'joris@10.10.0.24: Permission denied (publickey).\n'));
  await assert.rejects(h.git.worktrees('ssh://joris@10.10.0.24/srv/app'), /Permission denied \(publickey\)/);
});

// --- What changed: two phases ---

/**
 * The point of the two phases is that the first one is cheap, so these assert
 * on which commands were run as much as on what came back: one summary command
 * for the whole tree, and a patch only for the file someone opened.
 */

const HEAD_SHA = '1111111111111111111111111111111111111111';

/** NUL-terminated fields, as `-z` frames them. */
const record = (...fields: string[]): string => fields.map(field => `${field}\0`).join('');

const STATUS = record(
  `# branch.oid ${HEAD_SHA}`,
  '# branch.head main',
  '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/app.ts',
  '1 A. N... 000000 100644 100644 0000000 bbbbbbb package-lock.json',
  '? notes.md',
);

/** The raw section and the numstat section of one `--raw --numstat -z` call. */
const SUMMARY = record(
  ':100644 100644 aaaaaaa 0000000 M', 'src/app.ts',
  ':000000 100644 0000000 bbbbbbb A', 'package-lock.json',
  ':100644 100755 ccccccc ccccccc M', 'scripts/run.sh',
  '2\t2\tsrc/app.ts',
  '9000\t400\tpackage-lock.json',
  '0\t0\tscripts/run.sh',
);

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index aaaaaaa..ddddddd 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-was',
  '+is',
  ' keep',
  '',
].join('\n');

/**
 * Was this word part of the command?
 *
 * Locally it is an argument of its own; over ssh the whole git command line is
 * quoted into the last argument, which is what makes one script able to answer
 * both.
 */
const asked = (args: readonly string[], word: string): boolean =>
  args.includes(word) || (args[args.length - 1] ?? '').includes(`'${word}'`);

/** Which git subcommand a call is, ignoring the flags that wrap every one of them. */
const kindOf = (args: readonly string[]): string => {
  if (asked(args, '--numstat') && asked(args, '-w')) return 'whitespace';
  if (asked(args, '--numstat')) return 'summary';
  if (asked(args, 'status')) return 'status';
  if (asked(args, 'diff')) return 'patch';
  if (asked(args, 'rev-parse')) return 'rev-parse';
  if (asked(args, 'merge-base')) return 'merge-base';
  if (asked(args, 'show')) return 'show';
  return 'other';
};

type Answer = ExecResult | (() => ExecResult);

/**
 * A service over a runner that answers per subcommand, so a test can change one
 * answer — a status that moved, a ref that does not resolve — and leave the
 * rest alone.
 */
function twoPhase(answers: Record<string, Answer> = {}) {
  const defaults: Record<string, Answer> = {
    status: exit(0, STATUS),
    summary: exit(0, SUMMARY),
    patch: exit(0, PATCH),
    whitespace: exit(0, ''),
    'rev-parse': exit(0, '2222222222222222222222222222222222222222\n'),
    'merge-base': exit(0, '3333333333333333333333333333333333333333\n'),
    show: exit(0, 'the file as it was\n'),
  };
  const runner = fakeProcessRunner((_file, args) => {
    const answer = answers[kindOf(args)] ?? defaults[kindOf(args)];
    return typeof answer === 'function' ? answer() : answer;
  });
  const git = new GitService({ runner, log: silentLog });
  const of = (kind: string) => runner.calls.filter(call => kindOf(call.args) === kind);
  return { runner, git, of, count: (kind: string): number => of(kind).length };
}

test('the whole-tree phase runs one summary command and never a per-file diff', async () => {
  const h = twoPhase();
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });

  assert.equal(h.count('summary'), 1, 'one command for the whole tree');
  assert.equal(h.count('patch'), 0, 'nobody has opened a file yet');
  const [summary] = h.of('summary');
  assert.ok(summary.args.includes('--raw'), 'the raw half is what tells an addition from a modification');
  assert.ok(summary.args.includes('-z'));
  assert.ok(summary.args.includes('--no-optional-locks'),
    'in the argv, not the env, because ssh does not carry an environment');
  assert.ok(summary.args.includes(HEAD_SHA), 'against the very commit the status read named');
});

test('the summary carries sizes and classifications, and no lines at all', async () => {
  const h = twoPhase();
  const result = await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });

  assert.deepEqual(result.files.map(file => file.path),
    ['src/app.ts', 'package-lock.json', 'scripts/run.sh']);
  assert.deepEqual(result.files.map(file => file.hunks), [[], [], []],
    'the whole point: sizes without buying the lines');

  const [app, lock, script] = result.files;
  assert.deepEqual({ status: app.status, additions: app.additions, deletions: app.deletions },
    { status: 'M', additions: 2, deletions: 2 });
  assert.equal(app.generated, false);
  assert.equal(app.truncated, undefined);

  assert.equal(lock.status, 'A', 'numstat alone could not tell an addition from a file that grew');
  assert.equal(lock.additions, 9000);
  assert.equal(lock.generated, true);
  assert.equal(lock.truncated, 'generated', 'a lockfile is output before it is long');

  assert.deepEqual(script.modeChange, { from: '100644', to: '100755' },
    'a chmod has no hunks to mention itself in');
});

test('an untracked file is reported beside the diff, not inside it', async () => {
  const h = twoPhase();
  const result = await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });

  assert.deepEqual(result.untracked, [{ path: 'notes.md', status: '?' }]);
  assert.equal(result.files.some(file => file.path === 'notes.md'), false,
    'git\'s diff does not know about a file git does not track');
});

test('a file past the line threshold is marked for the Expand it will need', async () => {
  const long = record(
    ':100644 100644 aaaaaaa 0000000 M', 'src/by-hand.ts', '600\t20\tsrc/by-hand.ts');
  const h = twoPhase({ summary: exit(0, long) });
  const [file] = (await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' })).files;
  assert.equal(file.truncated, 'size');
  assert.equal(file.generated, false);
});

test('the worktree\'s own `.gitattributes` can call a file generated, and is read once', async () => {
  const marked = record(
    ':100644 100644 aaaaaaa 0000000 M', 'schema.graphql',
    ':100644 100644 bbbbbbb 0000000 M', 'src/app.ts',
    '4\t2\tschema.graphql',
    '1\t1\tsrc/app.ts',
  );
  const fs = fakeFileSystem({
    files: { '/Users/j/dev/proj/.gitattributes': 'schema.graphql linguist-generated\n' },
  });
  const runner = fakeProcessRunner((_file, args) => (
    kindOf(args) === 'status' ? exit(0, STATUS) : exit(0, marked)));
  const git = new GitService({ runner, log: silentLog, fs });

  const result = await git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  assert.deepEqual(result.files.map(file => file.generated), [true, false],
    'the repository saying so beats every heuristic, and is the only signal that is not a guess');

  // A second read of an untouched file costs a stat, not a parse — and the
  // answer does not drift.
  const again = await git.changedFiles('/Users/j/dev/proj', { kind: 'branch', ref: 'main' });
  assert.deepEqual(again.files.map(file => file.generated), [true, false]);
});

test('without a filesystem — a remote worktree, or a service built without one — the path rules still apply', async () => {
  const h = twoPhase();
  const result = await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  assert.equal(result.files.find(file => file.path === 'package-lock.json')?.generated, true);
});

// --- The base that was actually used ---

test('a branch base that resolves is used and reported as itself', async () => {
  const h = twoPhase();
  const base = { kind: 'branch', ref: 'main' } as const;
  const result = await h.git.changedFiles('/Users/j/dev/proj', base);

  assert.deepEqual(result.base, base);
  assert.deepEqual(result.requestedBase, base);
  assert.ok(h.of('summary')[0].args.includes('2222222222222222222222222222222222222222'),
    'the sha rev-parse gave, not the name');
});

test('a branch base that does not resolve falls back to uncommitted and says so', async () => {
  // `rev-parse --verify --quiet` on a ref that is gone: exit 1, and silence.
  const h = twoPhase({ 'rev-parse': exit(1, '') });
  const result = await h.git.changedFiles('/Users/j/dev/proj', { kind: 'branch', ref: 'origin/deleted' });

  assert.deepEqual(result.base, { kind: 'uncommitted' }, 'the one base that always works');
  assert.deepEqual(result.requestedBase, { kind: 'branch', ref: 'origin/deleted' },
    'the surface has to be able to say which base it asked for');
  assert.ok(h.of('summary')[0].args.includes(HEAD_SHA), 'against HEAD instead');
});

test('a merge base is asked for, and a detached HEAD is not asked at all', async () => {
  const onBranch = twoPhase();
  const merged = await onBranch.git.changedFiles('/Users/j/dev/proj', { kind: 'merge-base', ref: 'main' });
  assert.deepEqual(merged.base, { kind: 'merge-base', ref: 'main' });
  assert.equal(onBranch.count('merge-base'), 1);

  const detached = twoPhase({
    status: exit(0, record(`# branch.oid ${HEAD_SHA}`, '# branch.head (detached)')),
  });
  const result = await detached.git.changedFiles('/Users/j/dev/proj', { kind: 'merge-base', ref: 'main' });
  assert.deepEqual(result.base, { kind: 'uncommitted' },
    'the merge base of a HEAD that is not on a branch is not "what this branch did"');
  assert.equal(detached.count('merge-base'), 0, 'and there is no point asking');
});

test('a branch with no commits yet diffs against the empty tree rather than failing', async () => {
  const h = twoPhase({ status: exit(0, record('# branch.oid (initial)', '# branch.head main', '? new.ts')) });
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  assert.ok(h.of('summary')[0].args.includes('4b825dc642cb6eb9a060e54bf8d69288fbee4904'));
});

// --- The cache ---

test('asking twice for an unchanged tree does not run the diff twice', async () => {
  const h = twoPhase();
  const first = await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  const second = await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });

  assert.equal(second, first, 'the same answer, not an equal one');
  assert.equal(h.count('summary'), 1, 'the diff and the classification are what the cache saves');
  assert.equal(h.count('status'), 2,
    'the key is re-read, which is what makes it a key and not a timer');
});

test('a tree that changed underneath is read again', async () => {
  let output = STATUS;
  const h = twoPhase({ status: () => exit(0, output) });
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });

  output = record(`# branch.oid ${HEAD_SHA}`, '# branch.head main',
    '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/app.ts',
    '1 .M N... 100644 100644 100644 eeeeeee eeeeeee src/other.ts');
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  assert.equal(h.count('summary'), 2);
});

test('a commit landing invalidates the answer even when the working tree is identical', async () => {
  let head = HEAD_SHA;
  const h = twoPhase({
    status: () => exit(0, record(`# branch.oid ${head}`, '# branch.head main',
      '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/app.ts')),
  });
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  head = '9999999999999999999999999999999999999999';
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  assert.equal(h.count('summary'), 2);
});

test('a different base is a different answer, not a replacement for the first', async () => {
  const h = twoPhase();
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'branch', ref: 'main' });
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  assert.equal(h.count('summary'), 2, 'the first answer survived the second base');
});

// --- One file's hunks ---

test('opening a file is what runs the patch, and it is limited to that file', async () => {
  const h = twoPhase();
  const file = await h.git.diffFile('/Users/j/dev/proj', { kind: 'uncommitted' }, 'src/app.ts');

  assert.equal(h.count('patch'), 1);
  const [patch] = h.of('patch');
  assert.deepEqual(patch.args.slice(-2), ['--', 'src/app.ts'], 'a pathspec, so the cost is the file');
  assert.ok(patch.args.includes('--src-prefix=a/'), 'the prefixes the parser reads are pinned');
  assert.ok(patch.args.includes('--no-ext-diff'), 'an external diff driver would replace the output');
  assert.equal(file.hunks.length, 1);
  assert.deepEqual(file.hunks[0].lines.map(line => line.kind), ['ctx', 'del', 'add', 'ctx']);
});

test('the file list already knows the base, so opening a file does not re-read it', async () => {
  const h = twoPhase();
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'branch', ref: 'main' });
  const before = h.count('status') + h.count('rev-parse');
  await h.git.diffFile('/Users/j/dev/proj', { kind: 'branch', ref: 'main' }, 'src/app.ts');

  assert.equal(h.count('status') + h.count('rev-parse'), before,
    'the hunks then agree with the diffstat they were opened from');
  assert.ok(h.of('patch')[0].args.includes('2222222222222222222222222222222222222222'));
});

test('opening a file nobody listed first resolves the base for itself', async () => {
  const h = twoPhase();
  await h.git.diffFile('/Users/j/dev/proj', { kind: 'uncommitted' }, 'src/app.ts');
  assert.equal(h.count('status'), 1);
  assert.equal(h.count('patch'), 1);
});

test('a rename keeps its identity when the patch, limited to one path, cannot show it', async () => {
  const renamed = record(
    ':100644 100644 aaaaaaa bbbbbbb R097', 'src/old.ts', 'src/new.ts',
    '1\t1\t', 'src/old.ts', 'src/new.ts',
  );
  const h = twoPhase({
    summary: exit(0, renamed),
    patch: exit(0, [
      'diff --git a/src/new.ts b/src/new.ts',
      'index aaaaaaa..bbbbbbb 100644',
      '--- a/src/new.ts',
      '+++ b/src/new.ts',
      '@@ -1,2 +1,2 @@',
      '-was',
      '+is',
      ' keep',
      '',
    ].join('\n')),
  });
  await h.git.changedFiles('/Users/j/dev/proj', { kind: 'uncommitted' });
  const file = await h.git.diffFile('/Users/j/dev/proj', { kind: 'uncommitted' }, 'src/new.ts');

  assert.deepEqual(h.of('patch')[0].args.slice(-3), ['--', 'src/new.ts', 'src/old.ts'],
    'both sides, or git has nothing to pair the survivor with');
  assert.equal(file.status, 'R', 'the whole-tree pass saw the rename and the row keeps it');
  assert.equal(file.oldPath, 'src/old.ts');
  assert.equal(file.similarity, 97);
  assert.equal(file.hunks.length, 1, 'and the hunks are the ones git printed');
});

test('whitespace-only is decided with a second diff, and only for a file that could be', async () => {
  // `-w` leaving the file out entirely is git saying every changed line was
  // whitespace.
  const equal = twoPhase({ whitespace: exit(0, '') });
  const reformatted = await equal.git.diffFile('/Users/j/dev/proj', { kind: 'uncommitted' }, 'src/app.ts');
  assert.equal(equal.count('whitespace'), 1);
  assert.equal(reformatted.whitespaceOnly, true);

  const real = twoPhase({ whitespace: exit(0, record('1\t1\tsrc/app.ts')) });
  const edited = await real.git.diffFile('/Users/j/dev/proj', { kind: 'uncommitted' }, 'src/app.ts');
  assert.equal(edited.whitespaceOnly, false);
});

test('a lopsided diff cannot be whitespace-only, so nothing is spent finding out', async () => {
  const h = twoPhase({
    patch: exit(0, [
      'diff --git a/src/app.ts b/src/app.ts',
      'index aaaaaaa..ddddddd 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1,2 @@',
      ' keep',
      '+added',
      '',
    ].join('\n')),
  });
  const file = await h.git.diffFile('/Users/j/dev/proj', { kind: 'uncommitted' }, 'src/app.ts');
  assert.equal(h.count('whitespace'), 0);
  assert.equal(file.whitespaceOnly, false);
});

test('a file that turns out to match its base is a row with no hunks, not an error', async () => {
  const h = twoPhase({ patch: exit(0, '') });
  const file = await h.git.diffFile('/Users/j/dev/proj', { kind: 'uncommitted' }, 'src/app.ts');
  assert.deepEqual(file.hunks, []);
  assert.equal(file.path, 'src/app.ts');
});

// --- The rest of the reads ---

test('status is the working tree, conflicts and untracked files included', async () => {
  const h = twoPhase();
  assert.deepEqual(await h.git.status('/Users/j/dev/proj'), [
    { path: 'src/app.ts', status: 'M' },
    { path: 'package-lock.json', status: 'A' },
    { path: 'notes.md', status: '?' },
  ]);
});

test('a folder without a repository has no status and no changes, rather than an error', async () => {
  const h = twoPhase({
    status: exit(128, '', 'fatal: not a git repository (or any of the parent directories): .git\n'),
  });
  assert.deepEqual(await h.git.status('/Users/j/notes'), []);
  assert.deepEqual(await h.git.changedFiles('/Users/j/notes', { kind: 'branch', ref: 'main' }), {
    base: { kind: 'uncommitted' },
    requestedBase: { kind: 'branch', ref: 'main' },
    files: [],
    untracked: [],
  });
  assert.equal(h.count('summary'), 0, 'nothing to diff');
});

test('reading a file at a ref is `show`, and a missing path is thrown with git\'s own words', async () => {
  const h = twoPhase();
  assert.equal(await h.git.fileAt('/Users/j/dev/proj', 'HEAD', 'src/app.ts'), 'the file as it was\n');
  const [show] = h.of('show');
  assert.equal(show.args[show.args.length - 1], 'HEAD:src/app.ts');

  const missing = twoPhase({ show: exit(128, '', "fatal: path 'gone.ts' does not exist in 'HEAD'\n") });
  await assert.rejects(missing.git.fileAt('/Users/j/dev/proj', 'HEAD', 'gone.ts'), /does not exist in 'HEAD'/);
});

test('a path that tries to leave the worktree is refused before anything runs', async () => {
  const h = twoPhase();
  await assert.rejects(
    h.git.fileAt('/Users/j/dev/proj', 'HEAD', '../../.ssh/id_rsa'), /leaves the worktree/);
  await assert.rejects(
    h.git.diffFile('/Users/j/dev/proj', { kind: 'uncommitted' }, 'src/..\\..\\etc/passwd'),
    /leaves the worktree/);
  assert.equal(h.runner.calls.length, 0, 'nothing was run');
});

test('a status that fails for any other reason is thrown with what git said', async () => {
  const h = twoPhase({
    status: exit(1, '', 'error: could not lock config file .git/config: Permission denied\n'),
  });
  await assert.rejects(h.git.status('/Users/j/dev/proj'), /could not lock config file/);
});

// --- Remote ---

test('every phase of a remote worktree runs over ssh, in the directory sshd starts in', async () => {
  const h = twoPhase();
  await h.git.changedFiles('ssh://joris@10.10.0.24/srv/app', { kind: 'uncommitted' });
  await h.git.diffFile('ssh://joris@10.10.0.24/srv/app', { kind: 'uncommitted' }, 'src/app.ts');
  await h.git.fileAt('ssh://joris@10.10.0.24/srv/app', 'HEAD', 'src/app.ts');

  assert.ok(h.runner.calls.length >= 3);
  for (const call of h.runner.calls) {
    assert.equal(call.file, 'ssh', 'the same argv, run on the far host');
    assert.ok(call.args.includes('joris@10.10.0.24'));
    assert.equal(call.opts.timeoutMs, 30_000, 'the bound also covers the ssh handshake');
    assert.equal(remoteDirOf(call.args[call.args.length - 1]), 'srv/app',
      'relative to the login home, which is where sshd starts a command');
  }
  const [summary] = h.of('summary');
  assert.ok(summary.args[summary.args.length - 1].includes("'--no-optional-locks'"),
    'the lock flag travels in the argv, since ssh does not forward an environment');
});

// --- Which branch is the default one ---
//
// The diff base used to be the constant `merge-base with main`, which is right
// for most repositories and silently wrong for every one that kept `master`:
// the ref does not resolve, git falls back to uncommitted-only and says so, and
// the user is nonetheless reading a diff they did not ask for. So it is asked.

const SOME_SHA = '4444444444444444444444444444444444444444';

/** The ref a `rev-parse --verify <ref>^{commit}` is about. */
const verifiedRef = (args: readonly string[]): string =>
  (args.find(arg => arg.includes('^{commit}')) ?? '').replace(/'/g, '').replace('^{commit}', '');

/**
 * A repository that has the refs it is given, and points `origin/HEAD` at
 * `pointer` when there is one.
 */
function branchProbe(setup: { pointer?: string; refs?: readonly string[] } = {}) {
  const refs = new Set(setup.refs ?? []);
  const runner = fakeProcessRunner((_file, args) => {
    if (asked(args, 'symbolic-ref')) {
      return setup.pointer === undefined ? exit(1) : exit(0, `${setup.pointer}\n`);
    }
    if (asked(args, 'rev-parse')) {
      return refs.has(verifiedRef(args)) ? exit(0, `${SOME_SHA}\n`) : exit(1);
    }
    return exit(127, '', 'nothing else should be run to find the default branch');
  });
  const git = new GitService({ runner, log: silentLog });
  const verified = (): string[] => runner.calls
    .filter(call => asked(call.args, 'rev-parse'))
    .map(call => verifiedRef(call.args));
  return { runner, git, verified };
}

test('the default branch is what origin/HEAD points at, when it points anywhere', async () => {
  const h = branchProbe({ pointer: 'origin/trunk', refs: ['trunk', 'main'] });

  assert.equal(await h.git.defaultBranch('/Users/j/dev/proj'), 'trunk');
  assert.deepEqual(h.verified(), ['trunk'], 'the remote answered, so the guesses are never made');
  assert.deepEqual(h.runner.calls[0].args.slice(-4),
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
});

test('a full ref name from symbolic-ref reads the same as a short one', async () => {
  const h = branchProbe({ pointer: 'refs/remotes/origin/develop', refs: ['develop'] });
  assert.equal(await h.git.defaultBranch('/Users/j/dev/proj'), 'develop');
});

test('with no origin/HEAD — every git init — main is tried, and resolves', async () => {
  const h = branchProbe({ refs: ['main'] });

  assert.equal(await h.git.defaultBranch('/Users/j/dev/proj'), 'main');
  assert.deepEqual(h.verified(), ['main']);
});

test('a repository that kept master is not told it has a main', async () => {
  const h = branchProbe({ refs: ['master'] });

  assert.equal(await h.git.defaultBranch('/Users/j/dev/proj'), 'master');
  // Both spellings of `main` are ruled out before `master` is offered, which is
  // the whole point: the name is verified, never assumed.
  assert.deepEqual(h.verified(), ['main', 'origin/main', 'master']);
});

test('a branch that only exists on the remote is offered as the remote-tracking ref', async () => {
  const h = branchProbe({ refs: ['origin/main'] });

  // A fresh worktree of a clone that has never checked `main` out: the name
  // alone would not resolve and would fall straight back to uncommitted-only.
  assert.equal(await h.git.defaultBranch('/Users/j/dev/proj'), 'origin/main');
});

test('a repository where nothing resolves has no default branch, and says so', async () => {
  const h = branchProbe();

  assert.equal(await h.git.defaultBranch('/Users/j/dev/proj'), null);
  assert.deepEqual(h.verified(), ['main', 'origin/main', 'master', 'origin/master']);
});

test('the answer is remembered per worktree, but "nothing" is asked again', async () => {
  const h = branchProbe({ refs: ['main'] });

  await h.git.defaultBranch('/Users/j/dev/proj');
  const spent = h.runner.calls.length;
  assert.equal(await h.git.defaultBranch('/Users/j/dev/proj'), 'main');
  assert.equal(h.runner.calls.length, spent, 'a repository does not rename its default branch');

  // Another checkout is another question — and one with no answer yet is worth
  // asking again, because a first commit or a first remote is what changes it.
  const none = branchProbe();
  await none.git.defaultBranch('/Users/j/dev/proj');
  const asking = none.runner.calls.length;
  await none.git.defaultBranch('/Users/j/dev/proj');
  assert.ok(none.runner.calls.length > asking, 'nothing resolved, so nothing was cached');
});
