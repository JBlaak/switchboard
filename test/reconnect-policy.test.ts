import { test } from 'node:test';
import assert from 'node:assert';
import {
  describeSshExit, isFatalSshOutput, isRetryableSshExit, isSshDiagnosticOutput,
  MAX_RETRIES, outputProvesRemoteIsLive, remoteRetryDelay,
} from '../src/domain/remote/reconnect-policy';

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
