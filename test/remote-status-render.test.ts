import { test } from 'node:test';
import assert from 'node:assert';
import { statusBanner } from '../src/domain/terminal/ansi';
import { remoteStatusLabel } from '../src/domain/remote/remote-status';

test('a status banner opens and closes its own line', () => {
  /* When */
  const banner = statusBanner('reconnected', '\x1b[2m');

  /* Then */
  // Bare \n would leave the next line indented by however far the remote host
  // had printed; CRLF on both sides keeps the banner on a line of its own.
  assert.strictEqual(banner, '\r\n\x1b[2m── reconnected ──\x1b[0m\r\n');
});

test('remoteStatusLabel reads a first connect as connecting', () => {
  /* When */
  const label = remoteStatusLabel({ phase: 'connecting' });

  /* Then */
  assert.strictEqual(label, 'Connecting…');
});

test('remoteStatusLabel reads a later attempt as reconnecting', () => {
  /* When */
  const label = remoteStatusLabel({ phase: 'connecting', attempt: 2 });

  /* Then */
  assert.strictEqual(label, 'Reconnecting…');
});

test('remoteStatusLabel counts the backoff down in whole seconds', () => {
  /* Given */
  const now = 1_000_000;

  /* When */
  const inFour = remoteStatusLabel({ phase: 'retrying', retryAt: now + 4000 }, now);
  const inAMoment = remoteStatusLabel({ phase: 'retrying', retryAt: now + 100 }, now);

  /* Then */
  assert.strictEqual(inFour, 'Reconnecting in 4s');
  assert.strictEqual(inAMoment, 'Reconnecting in 1s');
});

test('remoteStatusLabel never shows a negative countdown', () => {
  /* Given */
  const now = 1_000_000;

  /* When */
  const label = remoteStatusLabel({ phase: 'retrying', retryAt: now - 3000 }, now);

  /* Then */
  // An overdue timer (the app was suspended, or the tick ran late) must read as
  // "about to happen", not "-3s".
  assert.strictEqual(label, 'Reconnecting…');
});

test('remoteStatusLabel yields to the normal running/stopped label when idle', () => {
  // Only an in-flight connection overrides the header; everything else is the
  // poll's business.
  /* Given */
  const idle = [null, undefined, { phase: 'connected' }, { phase: 'failed' }, { phase: 'disconnected' }] as const;

  for (const status of idle) {
    /* When */
    const label = remoteStatusLabel(status);

    /* Then */
    assert.strictEqual(label, null);
  }
});
