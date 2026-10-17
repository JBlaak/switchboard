import { test } from 'node:test';
import assert from 'node:assert/strict';

import { disableSleepArgs, parseSleepDisabled } from '../src/domain/power/sleep';

const PMSET = (flag: string): string => [
  'System-wide power settings:',
  ` SleepDisabled\t\t${flag}`,
  'Currently in use:',
  ' sleep                1 (sleep prevented by powerd, caffeinate)',
  ' displaysleep         1',
].join('\n');

test('reads SleepDisabled 1 as sleep disabled', () => {
  /* Given */
  const output = PMSET('1');

  /* When */
  const disabled = parseSleepDisabled(output);

  /* Then */
  assert.equal(disabled, true);
});

test('reads SleepDisabled 0 as sleep allowed, whatever caffeinate is doing', () => {
  /* Given */
  const output = PMSET('0');

  /* When */
  const disabled = parseSleepDisabled(output);

  /* Then */
  assert.equal(disabled, false);
});

test('answers null when the output has no SleepDisabled line', () => {
  /* Given */
  const output = ' sleep  1\n displaysleep  10\n';

  /* When */
  const disabled = parseSleepDisabled(output);

  /* Then */
  assert.equal(disabled, null);
});

test('answers null for empty output', () => {
  /* When */
  const disabled = parseSleepDisabled('');

  /* Then */
  assert.equal(disabled, null);
});

test('builds the pmset arguments to disable sleep', () => {
  /* When */
  const args = disableSleepArgs(true);

  /* Then */
  assert.deepEqual(args, ['disablesleep', '1']);
});

test('builds the pmset arguments to allow sleep', () => {
  /* When */
  const args = disableSleepArgs(false);

  /* Then */
  assert.deepEqual(args, ['disablesleep', '0']);
});
