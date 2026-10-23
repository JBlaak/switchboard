import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bonjourHostName, computerName } from '../src/infrastructure/system/computer-name';
import type { ScutilRead } from '../src/infrastructure/system/computer-name';

/** What this Mac is called, read from `scutil` (stood in for here). */

const scutil = (names: Record<string, string>): ScutilRead => (name) => {
  if (!(name in names)) throw new Error(`${name}: not set`);
  return names[name];
};

test('the Bonjour host name is the LocalHostName under .local', () => {
  /* Given */
  const read = scutil({ LocalHostName: 'Joriss-MacBook-Pro-2\n' });

  /* When */
  const name = bonjourHostName(read);

  /* Then */
  assert.equal(name, 'Joriss-MacBook-Pro-2.local');
});

test('without a LocalHostName there is no Bonjour name, for the advertiser to fall back from', () => {
  /* Given */
  const read = scutil({});

  /* When */
  const names = [bonjourHostName(read), bonjourHostName(scutil({ LocalHostName: '  ' }))];

  /* Then */
  assert.deepEqual(names, [null, null]);
});

test('the computer name is scutil\'s ComputerName', () => {
  /* Given */
  const read = scutil({ ComputerName: 'Joris’s MacBook Pro (2)\n' });

  /* When */
  const name = computerName(read);

  /* Then */
  assert.equal(name, 'Joris’s MacBook Pro (2)');
});
