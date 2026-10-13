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
  assert.equal(parseSleepDisabled(PMSET('1')), true);
});

test('reads SleepDisabled 0 as sleep allowed, whatever caffeinate is doing', () => {
  assert.equal(parseSleepDisabled(PMSET('0')), false);
});

test('answers null when the output has no SleepDisabled line', () => {
  assert.equal(parseSleepDisabled(' sleep  1\n displaysleep  10\n'), null);
  assert.equal(parseSleepDisabled(''), null);
});

test('builds the pmset arguments for each position', () => {
  assert.deepEqual(disableSleepArgs(true), ['disablesleep', '1']);
  assert.deepEqual(disableSleepArgs(false), ['disablesleep', '0']);
});
