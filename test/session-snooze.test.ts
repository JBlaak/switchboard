import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSnoozed, nextWake, snoozeOptions } from '../src/domain/session/snooze';

/** Local time, so the tests hold in any time zone: October 2026 runs Mon 19 … Sun 25. */
const local = (day: number, hours: number, minutes = 0): Date => new Date(2026, 9, day, hours, minutes);

/** The options as `label → local time`, for comparing at a glance. */
function offered(now: Date): Record<string, string> {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return Object.fromEntries(snoozeOptions(now).map(({ label, until }) => [
    label,
    `${until.toDateString().slice(0, 3)} ${pad(until.getDate())} ${pad(until.getHours())}:${pad(until.getMinutes())}`,
  ]));
}

test('on a Monday morning every option is open, later this week landing on Wednesday', () => {
  /* When */
  const options = offered(local(19, 9));

  /* Then */
  assert.deepEqual(options, {
    'After lunch': 'Mon 19 12:30',
    'Later today': 'Mon 19 15:00',
    'This evening': 'Mon 19 18:00',
    'Tomorrow': 'Tue 20 08:00',
    'Later this week': 'Wed 21 08:00',
    'This weekend': 'Fri 23 18:00',
  });
});

test('on a Tuesday later this week lands on Thursday morning', () => {
  /* When */
  const options = offered(local(20, 9));

  /* Then */
  assert.equal(options['Later this week'], 'Thu 22 08:00');
});

test('from Wednesday on there is no later this week', () => {
  /* When */
  const options = offered(local(21, 9));

  /* Then */
  assert.equal(options['Later this week'], undefined);
  assert.equal(options['This weekend'], 'Fri 23 18:00');
});

test('a time of day that has passed is no longer offered', () => {
  /* When */
  const options = offered(local(20, 12, 30));

  /* Then */
  assert.deepEqual(Object.keys(options), ['Later today', 'This evening', 'Tomorrow', 'Later this week', 'This weekend']);
});

test('in the evening only the days ahead are offered', () => {
  /* When */
  const options = offered(local(19, 18));

  /* Then */
  assert.deepEqual(Object.keys(options), ['Tomorrow', 'Later this week', 'This weekend']);
});

test('on a Friday afternoon this evening stands for the weekend too', () => {
  /* When */
  const options = offered(local(23, 14));

  /* Then */
  assert.deepEqual(options, {
    'Later today': 'Fri 23 15:00',
    'This evening': 'Fri 23 18:00',
    'Tomorrow': 'Sat 24 08:00',
  });
});

test('on a weekend only tomorrow is offered', () => {
  /* When */
  const saturday = offered(local(24, 19));
  const sunday = offered(local(25, 19));

  /* Then */
  assert.deepEqual(saturday, { 'Tomorrow': 'Sun 25 08:00' });
  assert.deepEqual(sunday, { 'Tomorrow': 'Mon 26 08:00' });
});

test('a session is asleep until its time and awake from it', () => {
  /* Given */
  const until = local(19, 15).toISOString();

  /* When */
  const before = isSnoozed(until, local(19, 14, 59).getTime());
  const after = isSnoozed(until, local(19, 15).getTime());

  /* Then */
  assert.equal(before, true);
  assert.equal(after, false);
});

test('the next wake is the earliest snooze still ahead', () => {
  /* Given */
  const snoozes = [local(19, 8).toISOString(), local(20, 8).toISOString(), null, local(19, 18).toISOString()];

  /* When */
  const next = nextWake(snoozes, local(19, 12).getTime());

  /* Then */
  assert.equal(next, local(19, 18).getTime());
});
