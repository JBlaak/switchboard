import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LanWatcher } from '../src/infrastructure/phone/lan-watcher';
import { fakeTimers } from './support/fakes';

/**
 * The listener follows the Mac to a new network (#194): the LAN addresses are
 * read on a timer, and only a real change restarts it.
 */

function harness(initial: string[]) {
  const timers = fakeTimers();
  let addresses = initial;
  let changes = 0;
  const watcher = new LanWatcher({ timers, addresses: () => addresses, onChange: () => { changes++; } });
  return {
    watcher,
    set: (next: string[]) => { addresses = next; },
    changes: () => changes,
    timers,
  };
}

test('the same addresses in another order are no change', () => {
  /* Given */
  const h = harness(['192.168.1.20', 'fe80::1%en0']);
  h.watcher.start();
  h.set(['fe80::1%en0', '192.168.1.20']);

  /* When */
  h.timers.tick();

  /* Then */
  assert.equal(h.changes(), 0);
});

test('a new address is reported once', () => {
  /* Given */
  const h = harness(['192.168.1.20']);
  h.watcher.start();
  h.set(['10.0.0.7']);

  /* When */
  h.timers.tick();

  /* Then */
  assert.equal(h.changes(), 1);
});

test('a stopped watcher reads nothing more', () => {
  /* Given */
  const h = harness(['192.168.1.20']);
  h.watcher.start();

  /* When */
  h.watcher.stop();

  /* Then */
  assert.equal(h.timers.pending, 0);
});
