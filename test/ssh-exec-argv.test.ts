import { test } from 'node:test';
import assert from 'node:assert';
import { buildSshArgv, buildSshExecArgv, CONNECT_TIMEOUT_SECONDS } from '../src/domain/remote/ssh-command';

const remote = { user: 'joris', host: '10.10.0.24', port: 22 };

test('buildSshExecArgv runs a one-shot command: no PTY, no agent forwarding, never prompts', () => {
  const argv = buildSshExecArgv(remote, ['git', 'status']);
  assert.ok(!argv.includes('-t'), 'no PTY for a command whose output is parsed');
  assert.ok(!argv.includes('-A'), 'agent forwarding is not needed to run git locally on the host');
  const batch = argv.indexOf('BatchMode=yes');
  assert.notStrictEqual(batch, -1, 'a background command must fail rather than wait for a password');
  assert.strictEqual(argv[batch - 1], '-o');
  assert.strictEqual(argv[argv.length - 2], 'joris@10.10.0.24', 'the target comes right before the command');
});

test('buildSshExecArgv bounds the connect and keepalive timers like the interactive variant', () => {
  const argv = buildSshExecArgv(remote, ['true']);
  const ct = argv.indexOf('ConnectTimeout=' + CONNECT_TIMEOUT_SECONDS);
  assert.notStrictEqual(ct, -1);
  assert.strictEqual(argv[ct - 1], '-o');
  assert.ok(argv.includes('ServerAliveInterval=15'));
  assert.ok(argv.includes('ServerAliveCountMax=3'));
});

test('buildSshExecArgv only passes -p for a non-default port', () => {
  assert.ok(!buildSshExecArgv(remote, ['true']).includes('-p'));
  const argv = buildSshExecArgv({ ...remote, port: 2222 }, ['true']);
  const pIdx = argv.indexOf('-p');
  assert.notStrictEqual(pIdx, -1);
  assert.strictEqual(argv[pIdx + 1], '2222');
  assert.ok(pIdx < argv.indexOf('joris@10.10.0.24'), '-p is an option, so it precedes the target');
});

test('buildSshExecArgv quotes each argument for the remote shell', () => {
  const argv = buildSshExecArgv(remote, ['git', '-C', '/srv/my app', 'log', "--format=%s '%an'"]);
  const command = argv[argv.length - 1];
  // ssh joins its trailing arguments with spaces and hands the result to the
  // remote login shell, so a space would split an argument in two and an
  // unescaped quote would end the string early.
  assert.strictEqual(command, `'git' '-C' '/srv/my app' 'log' '--format=%s '\\''%an'\\'''`);
});

test('buildSshExecArgv leaves the interactive tmux bootstrap alone', () => {
  const interactive = buildSshArgv(remote, 'abc12345', 'claude');
  assert.ok(interactive.includes('-t') && interactive.includes('-A'), 'the interactive variant still gets a PTY and the agent');
  assert.ok(!interactive.includes('BatchMode=yes'), 'and may still prompt, since the user is watching');
});
