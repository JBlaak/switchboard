import { test } from 'node:test';
import assert from 'node:assert';
import { buildSshArgv, buildSshSpawn } from '../src/domain/remote/ssh-command';

const remote = { user: 'joris', host: '10.10.0.24', port: 22 };

test('buildSshArgv attaches to tmux and passes no -p for the default port', () => {
  /* When */
  const argv = buildSshArgv(remote, '8f14e45f-ceea-4672-9b3a-1c2d3e4f5a6b', 'claude');

  /* Then */
  assert.ok(!argv.includes('-p'));
  assert.ok(argv.includes('-A'), 'forwards the SSH agent');
  assert.ok(argv.includes('joris@10.10.0.24'));
  const remoteCmd = argv[argv.length - 1];
  assert.match(remoteCmd, /ln -sf "\$SSH_AUTH_SOCK"/, 'refreshes the stable agent symlink on every connect');
  assert.match(remoteCmd, /tmux new-session -d -s sb-8f14e45f/);
  assert.match(remoteCmd, /send-keys -t sb-8f14e45f 'export SSH_AUTH_SOCK=\$HOME\/\.ssh\/switchboard-agent\.sock; claude' Enter/);
  assert.match(remoteCmd, /exec tmux attach-session -t sb-8f14e45f$/);
});

test('buildSshArgv passes -p for a non-default port, and a shell session does not launch claude', () => {
  /* When */
  const argvPort = buildSshArgv({ ...remote, port: 2222 }, 'abc12345', 'shell');

  /* Then */
  const pIdx = argvPort.indexOf('-p');
  assert.notStrictEqual(pIdx, -1);
  assert.strictEqual(argvPort[pIdx + 1], '2222');
  assert.ok(!argvPort[argvPort.length - 1]!.includes('claude'), 'shell sessions do not launch claude');
});

test('buildSshArgv creates and starts in the working directory when set', () => {
  /* Given */
  const withDir = { user: 'u', host: 'h', port: 22, dir: '~/apps/my project' };

  /* When */
  const cmd = buildSshArgv(withDir, 'abc12345', 'shell').pop()!;

  /* Then */
  assert.match(cmd, /mkdir -p "\$HOME\/apps\/my project"/);
  assert.match(cmd, /tmux new-session -d -s sb-abc12345 -c "\$HOME\/apps\/my project"/);
});

test('buildSshArgv starts in an absolute working directory as given', () => {
  /* Given */
  const withDir = { user: 'u', host: 'h', port: 22, dir: '/srv/app' };

  /* When */
  const absCmd = buildSshArgv(withDir, 'abc12345', 'shell').pop()!;

  /* Then */
  assert.match(absCmd, /-c "\/srv\/app"/);
});

test('buildSshArgv passes no -c without a working directory', () => {
  /* When */
  const noDirCmd = buildSshArgv({ user: 'u', host: 'h', port: 22 }, 'abc12345', 'shell').pop()!;

  /* Then */
  assert.ok(!noDirCmd.includes(' -c '), 'no -c without a working directory');
});

test('buildSshSpawn runs ssh through the login shell so profile env (SSH_AUTH_SOCK) applies', () => {
  /* Given */
  const argv = buildSshArgv({ user: 'joris', host: '10.10.0.24', port: 22 }, 'abc12345', 'claude');

  /* When */
  const spawned = buildSshSpawn(argv, '/bin/zsh');

  /* Then */
  assert.strictEqual(spawned.file, '/bin/zsh');
  // -i is what sources ~/.zshrc, where an agent socket export usually lives
  assert.deepStrictEqual(spawned.args.slice(0, 3), ['-l', '-i', '-c']);
  const cmd = spawned.args[3];
  assert.match(cmd, /^exec ssh /, 'exec keeps the PTY attached to ssh itself');
  assert.ok(cmd.includes("'joris@10.10.0.24'"), 'argv stays quoted for the shell');
  assert.ok(cmd.includes('attach-session'), 'the remote command survives quoting');
});

test('buildSshArgv bounds the connect and keepalive timers itself', () => {
  /* When */
  const argv = buildSshArgv({ user: 'u', host: 'h', port: 22 }, 'abc12345', 'claude');

  /* Then */
  // Without ConnectTimeout, an unreachable host hangs on the OS TCP timeout
  // (~75s) with no output at all — the connect looks like a frozen app.
  const ct = argv.indexOf('ConnectTimeout=10');
  assert.notStrictEqual(ct, -1, 'connect attempts are bounded');
  assert.strictEqual(argv[ct - 1], '-o');
  // Set explicitly rather than inherited, so a drop is noticed on a known
  // schedule regardless of the user's ssh_config.
  assert.ok(argv.includes('ServerAliveInterval=15'));
  assert.ok(argv.includes('ServerAliveCountMax=3'));
});
