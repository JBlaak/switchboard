import { test } from 'node:test';
import assert from 'node:assert/strict';

import { remoteLogLine } from '../src/renderer/features/remote/log-line';

const TARGET = 'joris@buildbox.local:~/apps/api';

test('a drop after connecting is logged as a lost connection', () => {
  /* When */
  const line = remoteLogLine(
    { phase: 'retrying', target: TARGET, reason: 'ssh connection failed or dropped', delayMs: 30_000, everConnected: true },
    { phase: 'connected', target: TARGET },
  );

  /* Then */
  assert.deepEqual(line, { text: 'connection lost: ssh connection failed or dropped', warn: true });
});

test('a host never reached is logged as unreachable', () => {
  /* When */
  const line = remoteLogLine(
    { phase: 'retrying', target: TARGET, reason: 'ssh connection timed out', delayMs: 30_000, everConnected: false },
    { phase: 'connecting', target: TARGET },
  );

  /* Then */
  assert.deepEqual(line, { text: `could not reach ${TARGET}: ssh connection timed out`, warn: true });
});

test('giving up is logged, as reconnecting or as connecting', () => {
  /* When */
  const reconnecting = remoteLogLine({ phase: 'failed', target: TARGET, reason: 'x', everConnected: true }, undefined);
  const connecting = remoteLogLine({ phase: 'failed', target: TARGET, reason: 'x', everConnected: false }, undefined);

  /* Then */
  assert.equal(reconnecting?.text, `gave up reconnecting to ${TARGET}`);
  assert.equal(connecting?.text, `gave up connecting to ${TARGET}`);
});

test('a status without a target names the remote host', () => {
  /* When */
  const line = remoteLogLine({ phase: 'failed', reason: 'x' }, undefined);

  /* Then */
  assert.equal(line?.text, 'gave up connecting to the remote host');
});

test('a reconnect is logged, a first connect is not', () => {
  /* When */
  const first = remoteLogLine({ phase: 'connected', target: TARGET }, { phase: 'connecting', target: TARGET });
  const again = remoteLogLine({ phase: 'connected', target: TARGET }, { phase: 'connecting', target: TARGET, attempt: 2, maxAttempts: 6 });

  /* Then */
  assert.equal(first, null);
  assert.deepEqual(again, { text: 'reconnected', warn: false });
});

test('connecting and disconnecting leave nothing in the scrollback', () => {
  /* When */
  const connecting = remoteLogLine({ phase: 'connecting', target: TARGET, attempt: 2, maxAttempts: 6 }, undefined);
  const disconnected = remoteLogLine({ phase: 'disconnected', target: TARGET }, { phase: 'connected' });

  /* Then */
  assert.equal(connecting, null);
  assert.equal(disconnected, null);
});
