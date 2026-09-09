import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GitService } from '../src/application/services/git-service';
import { fakeProcessRunner, silentLog } from './support/fakes';
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
