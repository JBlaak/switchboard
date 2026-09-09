import { test } from 'node:test';
import assert from 'node:assert';
import { statusBanner } from '../src/domain/terminal/ansi';
import { remoteStatusLabel } from '../src/domain/remote/remote-status';

test('a status banner opens and closes its own line', () => {
  // Bare \n would leave the next line indented by however far the remote host
  // had printed; CRLF on both sides keeps the banner on a line of its own.
  assert.strictEqual(
    statusBanner('reconnected', '\x1b[2m'),
    '\r\n\x1b[2m── reconnected ──\x1b[0m\r\n');
});

test('remoteStatusLabel distinguishes a first connect from a reconnect', () => {
  assert.strictEqual(remoteStatusLabel({ phase: 'connecting' }), 'Connecting…');
  assert.strictEqual(remoteStatusLabel({ phase: 'connecting', attempt: 2 }), 'Reconnecting…');
});

test('remoteStatusLabel counts the backoff down and never shows a negative', () => {
  const now = 1_000_000;
  assert.strictEqual(remoteStatusLabel({ phase: 'retrying', retryAt: now + 4000 }, now), 'Reconnecting in 4s');
  assert.strictEqual(remoteStatusLabel({ phase: 'retrying', retryAt: now + 100 }, now), 'Reconnecting in 1s');
  // An overdue timer (the app was suspended, or the tick ran late) must read as
  // "about to happen", not "-3s".
  assert.strictEqual(remoteStatusLabel({ phase: 'retrying', retryAt: now - 3000 }, now), 'Reconnecting…');
});

test('remoteStatusLabel yields to the normal running/stopped label when idle', () => {
  // Only an in-flight connection overrides the header; everything else is the
  // poll's business.
  assert.strictEqual(remoteStatusLabel(null), null);
  assert.strictEqual(remoteStatusLabel(undefined), null);
  assert.strictEqual(remoteStatusLabel({ phase: 'connected' }), null);
  assert.strictEqual(remoteStatusLabel({ phase: 'failed' }), null);
  assert.strictEqual(remoteStatusLabel({ phase: 'disconnected' }), null);
});
