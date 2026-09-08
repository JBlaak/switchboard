import { test } from 'node:test';
import assert from 'node:assert';
import { isRemoteProjectPath, remoteProjectPath, parseRemoteProjectPath,
  normalizeRemoteDir, validateRemoteInput, tmuxSessionName, buildSshArgv, buildSshSpawn,
  remoteRetryDelay, isRetryableSshExit, isFatalSshOutput, isSshDiagnosticOutput,
  outputProvesRemoteIsLive, describeSshExit, MAX_RETRIES, } from '../src/main/remote-projects.js';

test('remoteProjectPath omits the default port and round-trips through parse', () => {
  assert.strictEqual(remoteProjectPath({ user: 'joris', host: '10.10.0.24', port: 22 }), 'ssh://joris@10.10.0.24');
  assert.strictEqual(remoteProjectPath({ user: 'joris', host: '10.10.0.24' }), 'ssh://joris@10.10.0.24');
  assert.strictEqual(remoteProjectPath({ user: 'joris', host: 'vm.local', port: 2222 }), 'ssh://joris@vm.local:2222');
  assert.deepStrictEqual(parseRemoteProjectPath('ssh://joris@vm.local:2222'), { user: 'joris', host: 'vm.local', port: 2222, dir: null });
  assert.deepStrictEqual(parseRemoteProjectPath('ssh://joris@10.10.0.24'), { user: 'joris', host: '10.10.0.24', port: 22, dir: null });
  assert.strictEqual(parseRemoteProjectPath('/Users/joris/dev'), null);
});

test('working directory is part of the project identity and round-trips', () => {
  assert.strictEqual(
    remoteProjectPath({ user: 'u', host: 'h', dir: '~/apps/foo' }),
    'ssh://u@h/~/apps/foo');
  assert.strictEqual(
    remoteProjectPath({ user: 'u', host: 'h', port: 2222, dir: '/srv/app' }),
    'ssh://u@h:2222//srv/app');
  // "~", "" and trailing slashes normalize to the default (home)
  assert.strictEqual(remoteProjectPath({ user: 'u', host: 'h', dir: '~' }), 'ssh://u@h');
  assert.strictEqual(normalizeRemoteDir('~/apps/foo/'), '~/apps/foo');
  assert.strictEqual(normalizeRemoteDir('  '), null);
  assert.deepStrictEqual(
    parseRemoteProjectPath('ssh://u@h:2222//srv/app'),
    { user: 'u', host: 'h', port: 2222, dir: '/srv/app' });
  assert.deepStrictEqual(
    parseRemoteProjectPath('ssh://u@h/~/apps/foo'),
    { user: 'u', host: 'h', port: 22, dir: '~/apps/foo' });
});

test('isRemoteProjectPath distinguishes ssh pseudo-paths from filesystem paths', () => {
  assert.ok(isRemoteProjectPath('ssh://a@b'));
  assert.ok(!isRemoteProjectPath('/tmp/project'));
  assert.ok(!isRemoteProjectPath(null));
});

test('validateRemoteInput rejects characters that could escape the ssh argv', () => {
  assert.strictEqual(validateRemoteInput({ user: 'joris', host: '10.10.0.24' }), null);
  assert.strictEqual(validateRemoteInput({ user: 'joris', host: '10.10.0.24', port: '2222' }), null);
  assert.ok(validateRemoteInput({ user: 'joris; rm -rf /', host: 'h' }));
  assert.ok(validateRemoteInput({ user: 'joris', host: 'host$(x)' }));
  assert.ok(validateRemoteInput({ user: 'joris', host: 'h', port: 'abc' }));
  assert.ok(validateRemoteInput({ user: 'joris', host: 'h', port: 0 }));
  assert.ok(validateRemoteInput({}));
  assert.strictEqual(validateRemoteInput({ user: 'u', host: 'h', dir: '~/apps/my project' }), null);
  assert.ok(validateRemoteInput({ user: 'u', host: 'h', dir: '$(reboot)' }));
  assert.ok(validateRemoteInput({ user: 'u', host: 'h', dir: 'a"b' }));
});

test('tmuxSessionName is short and safe for unquoted shell use', () => {
  assert.strictEqual(tmuxSessionName('8f14e45f-ceea-4672-9b3a-1c2d3e4f5a6b'), 'sb-8f14e45f');
  assert.match(tmuxSessionName('weird id!*'), /^sb-[a-zA-Z0-9]*$/);
});

test('buildSshArgv attaches to tmux and only passes -p for non-default ports', () => {
  const remote = { user: 'joris', host: '10.10.0.24', port: 22 };
  const argv = buildSshArgv(remote, '8f14e45f-ceea-4672-9b3a-1c2d3e4f5a6b', 'claude');
  assert.ok(!argv.includes('-p'));
  assert.ok(argv.includes('-A'), 'forwards the SSH agent');
  assert.ok(argv.includes('joris@10.10.0.24'));
  const remoteCmd = argv[argv.length - 1];
  assert.match(remoteCmd, /ln -sf "\$SSH_AUTH_SOCK"/, 'refreshes the stable agent symlink on every connect');
  assert.match(remoteCmd, /tmux new-session -d -s sb-8f14e45f/);
  assert.match(remoteCmd, /send-keys -t sb-8f14e45f 'export SSH_AUTH_SOCK=\$HOME\/\.ssh\/switchboard-agent\.sock; claude' Enter/);
  assert.match(remoteCmd, /exec tmux attach-session -t sb-8f14e45f$/);

  const argvPort = buildSshArgv({ ...remote, port: 2222 }, 'abc12345', 'shell');
  const pIdx = argvPort.indexOf('-p');
  assert.notStrictEqual(pIdx, -1);
  assert.strictEqual(argvPort[pIdx + 1], '2222');
  assert.ok(!argvPort[argvPort.length - 1]!.includes('claude'), 'shell sessions do not launch claude');
});

test('buildSshArgv creates and starts in the working directory when set', () => {
  const remote = { user: 'u', host: 'h', port: 22, dir: '~/apps/my project' };
  const cmd = buildSshArgv(remote, 'abc12345', 'shell').pop()!;
  assert.match(cmd, /mkdir -p "\$HOME\/apps\/my project"/);
  assert.match(cmd, /tmux new-session -d -s sb-abc12345 -c "\$HOME\/apps\/my project"/);

  const absCmd = buildSshArgv({ ...remote, dir: '/srv/app' }, 'abc12345', 'shell').pop()!;
  assert.match(absCmd, /-c "\/srv\/app"/);

  const noDirCmd = buildSshArgv({ user: 'u', host: 'h', port: 22 }, 'abc12345', 'shell').pop()!;
  assert.ok(!noDirCmd.includes(' -c '), 'no -c without a working directory');
});

test('buildSshSpawn runs ssh through the login shell so profile env (SSH_AUTH_SOCK) applies', () => {
  const argv = buildSshArgv({ user: 'joris', host: '10.10.0.24', port: 22 }, 'abc12345', 'claude');
  const spawned = buildSshSpawn(argv, { shell: '/bin/zsh', windows: false });
  assert.strictEqual(spawned.file, '/bin/zsh');
  // -i is what sources ~/.zshrc, where an agent socket export usually lives
  assert.deepStrictEqual(spawned.args.slice(0, 3), ['-l', '-i', '-c']);
  const cmd = spawned.args[3];
  assert.match(cmd, /^exec ssh /, 'exec keeps the PTY attached to ssh itself');
  assert.ok(cmd.includes("'joris@10.10.0.24'"), 'argv stays quoted for the shell');
  assert.ok(cmd.includes('attach-session'), 'the remote command survives quoting');

  // Windows has no exec and finds its agent over a named pipe: spawn ssh directly
  const onWindows = buildSshSpawn(argv, { shell: 'C:\\Windows\\System32\\cmd.exe', windows: true });
  assert.strictEqual(onWindows.file, 'ssh');
  assert.deepStrictEqual(onWindows.args, argv);
});

test('buildSshArgv bounds the connect and keepalive timers itself', () => {
  const argv = buildSshArgv({ user: 'u', host: 'h', port: 22 }, 'abc12345', 'claude');
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

test('remoteRetryDelay backs off and then holds, clamping out-of-range attempts', () => {
  const delays = [1, 2, 3, 4, 5, 6].map(remoteRetryDelay);
  assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 15000, 30000]);
  // Attempts past the table hold at the cap rather than returning undefined,
  // and attempt 0 (or a stray negative) still yields the first delay.
  assert.strictEqual(remoteRetryDelay(MAX_RETRIES + 5), 30000);
  assert.strictEqual(remoteRetryDelay(0), 1000);
  assert.strictEqual(remoteRetryDelay(-3), 1000);
});

test('only ssh transport failures are retried', () => {
  assert.ok(isRetryableSshExit(255), 'ssh reports its own failures as 255');
  // 0 = the user left the remote shell or detached tmux; 127 = our own
  // tmux-is-missing bail-out. Reconnecting either would fight the user.
  assert.ok(!isRetryableSshExit(0));
  assert.ok(!isRetryableSshExit(127));
  assert.ok(!isRetryableSshExit(1));
});

test('a signalled ssh is retried even though its exit code reads clean', () => {
  // node-pty reports a signal-terminated child as exitCode 0, so code alone
  // cannot tell a killed ssh from one the user exited. Switchboard's own kills
  // are filtered out earlier by the userDisconnected flag, so a signal getting
  // this far means the link died without ssh reporting it.
  assert.ok(isRetryableSshExit(0, 15));
  assert.ok(isRetryableSshExit(0, 9));
  assert.ok(isRetryableSshExit(1, 1));
  // No signal: the code decides, as before.
  assert.ok(!isRetryableSshExit(0, undefined));
  assert.ok(!isRetryableSshExit(0, 0));
});

test('isFatalSshOutput stops the backoff only for failures ssh will repeat', () => {
  assert.ok(isFatalSshOutput('joris@h: Permission denied (publickey).'));
  assert.ok(isFatalSshOutput('Host key verification failed.'));
  assert.ok(isFatalSshOutput('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@'));
  assert.ok(isFatalSshOutput('Switchboard: tmux is not installed on the remote host'));
  // Name resolution is deliberately retryable: DNS is routinely unavailable
  // for a few seconds after a wake, which is when reconnecting should work.
  assert.ok(!isFatalSshOutput('ssh: Could not resolve hostname vm.local'));
  assert.ok(!isFatalSshOutput('Last login: Thu Sep  4 11:12:22 2026'));
  assert.ok(!isFatalSshOutput(''));
  assert.ok(!isFatalSshOutput(null));
});

test('ssh transport errors do not count as the far end talking', () => {
  // The exact lines a wedged or unreachable host produces. Treating any of
  // these as a successful connect made the connecting card disappear and then
  // reappear as "reconnecting" a few seconds later.
  assert.ok(isSshDiagnosticOutput('Connection to 10.10.0.24 port 22 timed out'));
  assert.ok(isSshDiagnosticOutput('Connection timed out during banner exchange'));
  assert.ok(isSshDiagnosticOutput('ssh: connect to host h port 22: Host is down'));
  assert.ok(isSshDiagnosticOutput('Connection closed by 10.10.0.24 port 22'));
  assert.ok(isSshDiagnosticOutput('kex_exchange_identification: read: Connection reset by peer'));
  assert.ok(isSshDiagnosticOutput('joris@h: Permission denied (publickey).'));
});

test('outputProvesRemoteIsLive: a prompt or a repaint ends the connecting state', () => {
  // The user has to be able to answer these, so the card must step aside.
  assert.ok(outputProvesRemoteIsLive('Are you sure you want to continue connecting (yes/no)? '));
  assert.ok(outputProvesRemoteIsLive("joris@10.10.0.24's password: "));
  assert.ok(outputProvesRemoteIsLive('Welcome to Ubuntu 24.04.1 LTS'));
  assert.ok(outputProvesRemoteIsLive('\x1b[?1049h\x1b[H'), 'tmux taking the screen');
});

test('outputProvesRemoteIsLive: nothing and bad news both prove nothing', () => {
  // Whitespace-only chunks say nothing either way and must not be mistaken for
  // a connect — that would dismiss the card while ssh is still dialling.
  assert.ok(!outputProvesRemoteIsLive(''));
  assert.ok(!outputProvesRemoteIsLive('\r\n'));
  assert.ok(!outputProvesRemoteIsLive('   '));
  assert.ok(!outputProvesRemoteIsLive(null));
  // ssh's own errors mean the opposite of a connect.
  assert.ok(!outputProvesRemoteIsLive('Connection timed out during banner exchange'));
  assert.ok(!outputProvesRemoteIsLive('ssh: connect to host h port 22: Host is down'));
});

test('describeSshExit names the reason shown in the terminal', () => {
  assert.match(describeSshExit(255), /connection failed or dropped/);
  assert.match(describeSshExit(127), /not found/);
  assert.strictEqual(describeSshExit(0), 'disconnected');
  assert.match(describeSshExit(3), /code 3/);
  // A signal outranks the code, which is 0 and therefore meaningless here.
  assert.match(describeSshExit(0, 9), /signal 9/);
});
