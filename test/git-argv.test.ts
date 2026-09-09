import { test } from 'node:test';
import assert from 'node:assert';
import { gitArgv, gitEnv, localGit, remoteGit } from '../src/domain/git/git-argv';

test('gitArgv disables the pager and colour and targets the directory with -C', () => {
  const argv = gitArgv('/Users/j/dev/proj', ['worktree', 'list', '--porcelain']);
  assert.deepStrictEqual(argv, [
    '--no-pager', '-c', 'color.ui=false', '-C', '/Users/j/dev/proj',
    'worktree', 'list', '--porcelain',
  ]);
});

test('gitEnv adds the no-lock, no-prompt, no-system-config variables on top of the base env', () => {
  const env = gitEnv({ PATH: '/usr/bin', HOME: '/Users/j' });
  assert.strictEqual(env.PATH, '/usr/bin', 'the base environment is kept');
  assert.strictEqual(env.HOME, '/Users/j');
  // Never take the index lock from under a claude process running git in the same dir.
  assert.strictEqual(env.GIT_OPTIONAL_LOCKS, '0');
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0', 'a credential prompt fails instead of hanging');
  assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, '1');
});

test('gitEnv wins over a base env that would re-enable locks', () => {
  const env = gitEnv({ GIT_OPTIONAL_LOCKS: '1', GIT_TERMINAL_PROMPT: '1' });
  assert.strictEqual(env.GIT_OPTIONAL_LOCKS, '0');
  assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
});

test('gitEnv does not mutate the base env', () => {
  const base = { PATH: '/usr/bin' };
  gitEnv(base);
  assert.deepStrictEqual(base, { PATH: '/usr/bin' });
});

test('localGit spawns git itself with the full argv', () => {
  const inv = localGit('/Users/j/dev/proj', ['rev-parse', 'HEAD']);
  assert.strictEqual(inv.file, 'git');
  assert.deepStrictEqual(inv.args, ['--no-pager', '-c', 'color.ui=false', '-C', '/Users/j/dev/proj', 'rev-parse', 'HEAD']);
});

test('remoteGit spawns ssh whose final argument is the quoted git command', () => {
  const inv = remoteGit({ user: 'joris', host: '10.10.0.24', port: 2222 }, '/srv/my app', ['worktree', 'list', '--porcelain']);
  assert.strictEqual(inv.file, 'ssh');
  assert.ok(inv.args.includes('joris@10.10.0.24'));
  const pIdx = inv.args.indexOf('-p');
  assert.notStrictEqual(pIdx, -1);
  assert.strictEqual(inv.args[pIdx + 1], '2222');
  const command = inv.args[inv.args.length - 1];
  assert.strictEqual(
    command,
    "'git' '--no-pager' '-c' 'color.ui=false' '-C' '/srv/my app' 'worktree' 'list' '--porcelain'",
    'each argument is quoted for the remote shell so a directory with a space stays one argument',
  );
});
