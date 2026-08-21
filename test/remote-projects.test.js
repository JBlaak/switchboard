const { test } = require('node:test');
const assert = require('node:assert');
const {
  isRemoteProjectPath, remoteProjectPath, parseRemoteProjectPath,
  normalizeRemoteDir, validateRemoteInput, tmuxSessionName, buildSshArgv, buildSshSpawn,
} = require('../remote-projects');

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
  assert.ok(!argvPort[argvPort.length - 1].includes('claude'), 'shell sessions do not launch claude');
});

test('buildSshArgv creates and starts in the working directory when set', () => {
  const remote = { user: 'u', host: 'h', port: 22, dir: '~/apps/my project' };
  const cmd = buildSshArgv(remote, 'abc12345', 'shell').pop();
  assert.match(cmd, /mkdir -p "\$HOME\/apps\/my project"/);
  assert.match(cmd, /tmux new-session -d -s sb-abc12345 -c "\$HOME\/apps\/my project"/);

  const absCmd = buildSshArgv({ ...remote, dir: '/srv/app' }, 'abc12345', 'shell').pop();
  assert.match(absCmd, /-c "\/srv\/app"/);

  const noDirCmd = buildSshArgv({ user: 'u', host: 'h', port: 22 }, 'abc12345', 'shell').pop();
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
