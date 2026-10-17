import { test } from 'node:test';
import assert from 'node:assert';
import {
  describeSshExit, isFatalSshOutput, isRetryableSshExit, isSshDiagnosticOutput,
  MAX_RETRIES, outputProvesRemoteIsLive, remoteRetryDelay,
} from '../src/domain/remote/reconnect-policy';

test('remoteRetryDelay backs off and then holds', () => {
  /* Given */
  const attempts = [1, 2, 3, 4, 5, 6];

  /* When */
  const delays = attempts.map(remoteRetryDelay);

  /* Then */
  assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 15000, 30000]);
});

test('remoteRetryDelay clamps out-of-range attempts', () => {
  // Attempts past the table hold at the cap rather than returning undefined,
  // and attempt 0 (or a stray negative) still yields the first delay.
  /* When */
  const pastTable = remoteRetryDelay(MAX_RETRIES + 5);
  const zero = remoteRetryDelay(0);
  const negative = remoteRetryDelay(-3);

  /* Then */
  assert.strictEqual(pastTable, 30000);
  assert.strictEqual(zero, 1000);
  assert.strictEqual(negative, 1000);
});

test('only ssh transport failures are retried', () => {
  /* When */
  const transportFailure = isRetryableSshExit(255);
  // 0 = the user left the remote shell or detached tmux; 127 = our own
  // tmux-is-missing bail-out. Reconnecting either would fight the user.
  const userExit = isRetryableSshExit(0);
  const tmuxMissing = isRetryableSshExit(127);
  const otherFailure = isRetryableSshExit(1);

  /* Then */
  assert.ok(transportFailure, 'ssh reports its own failures as 255');
  assert.ok(!userExit);
  assert.ok(!tmuxMissing);
  assert.ok(!otherFailure);
});

test('a signalled ssh is retried even though its exit code reads clean', () => {
  // node-pty reports a signal-terminated child as exitCode 0, so code alone
  // cannot tell a killed ssh from one the user exited. Switchboard's own kills
  // are filtered out earlier by the userDisconnected flag, so a signal getting
  // this far means the link died without ssh reporting it.
  /* When */
  const terminated = isRetryableSshExit(0, 15);
  const killed = isRetryableSshExit(0, 9);
  const hungUp = isRetryableSshExit(1, 1);
  // No signal: the code decides, as before.
  const noSignal = isRetryableSshExit(0, undefined);
  const zeroSignal = isRetryableSshExit(0, 0);

  /* Then */
  assert.ok(terminated);
  assert.ok(killed);
  assert.ok(hungUp);
  assert.ok(!noSignal);
  assert.ok(!zeroSignal);
});

test('isFatalSshOutput stops the backoff only for failures ssh will repeat', () => {
  /* Given */
  const fatal = [
    'joris@h: Permission denied (publickey).',
    'Host key verification failed.',
    '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
    'Switchboard: tmux is not installed on the remote host',
  ];
  const notFatal = [
    // Name resolution is deliberately retryable: DNS is routinely unavailable
    // for a few seconds after a wake, which is when reconnecting should work.
    'ssh: Could not resolve hostname vm.local',
    'Last login: Thu Sep  4 11:12:22 2026',
    '',
    null,
  ];

  /* When */
  const fatalVerdicts = fatal.map(isFatalSshOutput);
  const notFatalVerdicts = notFatal.map(isFatalSshOutput);

  /* Then */
  for (const [i, verdict] of fatalVerdicts.entries()) assert.ok(verdict, String(fatal[i]));
  for (const [i, verdict] of notFatalVerdicts.entries()) assert.ok(!verdict, String(notFatal[i]));
});

test('ssh transport errors do not count as the far end talking', () => {
  // The exact lines a wedged or unreachable host produces. Treating any of
  // these as a successful connect made the connecting card disappear and then
  // reappear as "reconnecting" a few seconds later.
  /* Given */
  const lines = [
    'Connection to 10.10.0.24 port 22 timed out',
    'Connection timed out during banner exchange',
    'ssh: connect to host h port 22: Host is down',
    'Connection closed by 10.10.0.24 port 22',
    'kex_exchange_identification: read: Connection reset by peer',
    'joris@h: Permission denied (publickey).',
  ];

  /* When */
  const verdicts = lines.map(isSshDiagnosticOutput);

  /* Then */
  for (const [i, verdict] of verdicts.entries()) assert.ok(verdict, lines[i]);
});

test('outputProvesRemoteIsLive: a prompt or a repaint ends the connecting state', () => {
  // The user has to be able to answer these, so the card must step aside.
  /* When */
  const hostKeyPrompt = outputProvesRemoteIsLive('Are you sure you want to continue connecting (yes/no)? ');
  const passwordPrompt = outputProvesRemoteIsLive("joris@10.10.0.24's password: ");
  const motd = outputProvesRemoteIsLive('Welcome to Ubuntu 24.04.1 LTS');
  const tmuxRepaint = outputProvesRemoteIsLive('\x1b[?1049h\x1b[H');

  /* Then */
  assert.ok(hostKeyPrompt);
  assert.ok(passwordPrompt);
  assert.ok(motd);
  assert.ok(tmuxRepaint, 'tmux taking the screen');
});

test('outputProvesRemoteIsLive: nothing and bad news both prove nothing', () => {
  /* Given */
  const chunks = [
    // Whitespace-only chunks say nothing either way and must not be mistaken for
    // a connect — that would dismiss the card while ssh is still dialling.
    '',
    '\r\n',
    '   ',
    null,
    // ssh's own errors mean the opposite of a connect.
    'Connection timed out during banner exchange',
    'ssh: connect to host h port 22: Host is down',
  ];

  /* When */
  const verdicts = chunks.map(outputProvesRemoteIsLive);

  /* Then */
  for (const [i, verdict] of verdicts.entries()) assert.ok(!verdict, JSON.stringify(chunks[i]));
});

test('describeSshExit names the reason shown in the terminal', () => {
  /* When */
  const transport = describeSshExit(255);
  const notFound = describeSshExit(127);
  const clean = describeSshExit(0);
  const other = describeSshExit(3);
  // A signal outranks the code, which is 0 and therefore meaningless here.
  const signalled = describeSshExit(0, 9);

  /* Then */
  assert.match(transport, /connection failed or dropped/);
  assert.match(notFound, /not found/);
  assert.strictEqual(clean, 'disconnected');
  assert.match(other, /code 3/);
  assert.match(signalled, /signal 9/);
});
