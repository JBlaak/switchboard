/** A schedule's cron in plain English, as the Schedule manager says it. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeCron} from '../src/domain/schedule/cadence';

test('a daily run in the night is nightly, and one in the day is daily', () => {
    /* When */
    const said = ['0 3 * * *', '30 22 * * *', '0 9 * * *', '15 3 * * 0-6'].map(describeCron);

    /* Then */
    assert.deepEqual(said, [
        'Every night at 03:00',
        'Every night at 22:30',
        'Every day at 09:00',
        'Every night at 03:15',
    ]);
});

test('weekdays, weekends, one day and a few days are named', () => {
    /* When */
    const said = ['30 6 * * 1-5', '0 10 * * 0,6', '0 9 * * 1', '0 5 * * 7', '0 9 * * 4,1'].map(describeCron);

    /* Then */
    assert.deepEqual(said, [
        'Weekdays at 06:30',
        'Weekends at 10:00',
        'Every Monday at 09:00',
        'Every Sunday at 05:00',
        'Mondays and Thursdays at 09:00',
    ]);
});

test('hourly, every few hours and every few minutes', () => {
    /* When */
    const said = ['15 * * * *', '0 */4 * * *', '30 */2 * * *', '*/10 * * * *', '* * * * *'].map(describeCron);

    /* Then */
    assert.deepEqual(said, [
        'Every hour at :15',
        'Every 4 hours',
        'Every 2 hours at :30',
        'Every 10 minutes',
        'Every minute',
    ]);
});

test('a day of the month is monthly', () => {
    /* When */
    const said = ['0 8 1 * *', '0 8 22 * *'].map(describeCron);

    /* Then */
    assert.deepEqual(said, ['Monthly on the 1st at 08:00', 'Monthly on the 22nd at 08:00']);
});

test('anything else is shown as the cron itself', () => {
    /* When */
    const said = ['0 3 * 6 *', '0 3,15 * * *', 'nonsense', '0 3 1 * 1'].map(describeCron);

    /* Then */
    assert.deepEqual(said, ['0 3 * 6 *', '0 3,15 * * *', 'nonsense', '0 3 1 * 1']);
});
