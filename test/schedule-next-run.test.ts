/**
 * A schedule's next time and its plain-English line: the next minute agrees
 * with the tick's matcher, the walk skips the minute summer time removes, and
 * the common crons read as the page says them.
 */
process.env.TZ = 'Europe/Amsterdam';

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {cronMatches} from '../src/domain/schedule/cron';
import {clockTime, describeCron, earliestTimeOfDay, isValidCron, nextRunAfter} from '../src/domain/schedule/next-run';

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();

test('a nightly cron next runs at its time tonight', () => {
    /* Given */
    const now = at(2026, 11, 23, 14, 10);

    /* When */
    const next = nextRunAfter('0 3 * * *', now);

    /* Then */
    assert.equal(next, at(2026, 11, 24, 3, 0));
});

test('the next run is strictly after the moment, even on the matching minute', () => {
    /* Given */
    const now = at(2026, 11, 24, 3, 0) + 20_000;

    /* When */
    const next = nextRunAfter('0 3 * * *', now);

    /* Then */
    assert.equal(next, at(2026, 11, 25, 3, 0));
});

test('a weekday cron on a Friday evening next runs on Monday', () => {
    /* Given: 27 November 2026 is a Friday */
    const now = at(2026, 11, 27, 20, 0);

    /* When */
    const next = nextRunAfter('30 6 * * 1-5', now);

    /* Then */
    assert.equal(next, at(2026, 11, 30, 6, 30));
});

test('lists and steps find the next listed minute within the hour', () => {
    /* Given */
    const now = at(2026, 11, 23, 10, 16);

    /* When */
    const listed = nextRunAfter('5,20,40 * * * *', now);
    const stepped = nextRunAfter('*/15 * * * *', now);

    /* Then */
    assert.equal(listed, at(2026, 11, 23, 10, 20));
    assert.equal(stepped, at(2026, 11, 23, 10, 30));
});

test('a yearly cron on 29 February is found years ahead', () => {
    /* When */
    const next = nextRunAfter('0 12 29 2 *', at(2026, 3, 1));

    /* Then */
    assert.equal(next, at(2028, 2, 29, 12, 0));
});

test('a cron that never matches has no next run', () => {
    /* When */
    const next = nextRunAfter('0 0 31 2 *', at(2026, 1, 1));

    /* Then */
    assert.equal(next, null);
});

test('the minute summer time skips is passed over, as the tick passes over it', () => {
    /* Given: in Amsterdam the clocks go from 02:00 to 03:00 on 29 March 2026 */
    const now = at(2026, 3, 28, 12, 0);

    /* When */
    const next = nextRunAfter('30 2 * * *', now);

    /* Then */
    assert.equal(next, at(2026, 3, 30, 2, 30));
});

test('the next run is the first minute the tick’s matcher accepts', () => {
    /* Given */
    const crons = ['0 3 * * *', '*/7 */5 * * *', '15 9 1-7 * 1', '0,30 22-23 * * 0,6', '59 23 31 12 *', '0 0 */2 * *'];
    const now = at(2026, 11, 23, 13, 37);

    for (const cron of crons) {
        /* When */
        const next = nextRunAfter(cron, now)!;

        /* Then */
        assert.ok(cronMatches(cron, new Date(next)), `${cron} matches at its next run`);
        for (let t = now + 60_000 - (now % 60_000); t < next; t += 60_000) {
            if (cronMatches(cron, new Date(t))) assert.fail(`${cron} matched earlier, at ${new Date(t).toString()}`);
        }
    }
});

test('a cron is valid only as five fields the matcher reads as written', () => {
    /* Then */
    assert.equal(isValidCron('0 3 * * *'), true);
    assert.equal(isValidCron('*/15 9-17 * * 1-5'), true);
    assert.equal(isValidCron('0 3 * *'), false);
    assert.equal(isValidCron('60 3 * * *'), false);
    assert.equal(isValidCron('0 3 * * 7'), false);
    assert.equal(isValidCron('0 3 * * MON'), false);
    assert.equal(isValidCron('*/0 3 * * *'), false);
    assert.equal(isValidCron('0 5-3 * * *'), false);
    assert.equal(isValidCron('0 0 31 2 *'), false);
    assert.equal(isValidCron('@daily'), false);
});

test('the earliest nightly time is the first hour and minute in the window', () => {
    /* Then */
    assert.equal(earliestTimeOfDay('20 3 * * *', 0, 420), 200);
    assert.equal(earliestTimeOfDay('0 22,2 * * *', 0, 420), 120);
    assert.equal(earliestTimeOfDay('0 9 * * *', 0, 420), null);
    assert.equal(earliestTimeOfDay('*/30 * * * *', 0, 420), 0);
});

test('a clock time wraps round midnight', () => {
    /* Then */
    assert.equal(clockTime(175), '02:55');
    assert.equal(clockTime(-3), '23:57');
});

test('the common crons read in plain English', () => {
    /* Then */
    assert.equal(describeCron('0 3 * * *'), 'Every night at 03:00');
    assert.equal(describeCron('0 9 * * *'), 'Every day at 09:00');
    assert.equal(describeCron('30 6 * * 1-5'), 'Weekdays at 06:30');
    assert.equal(describeCron('0 10 * * 0,6'), 'Weekends at 10:00');
    assert.equal(describeCron('0 9 * * 1'), 'Every Monday at 09:00');
    assert.equal(describeCron('0 9 * * 1,4'), 'Every Monday and Thursday at 09:00');
    assert.equal(describeCron('15 * * * *'), 'Every hour at :15');
    assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
    assert.equal(describeCron('0 */6 * * *'), 'Every 6 hours at :00');
});

test('anything more particular reads as the cron itself', () => {
    /* Then */
    assert.equal(describeCron('0 3 1 * *'), '0 3 1 * *');
    assert.equal(describeCron('0,30 3 * * *'), '0,30 3 * * *');
    assert.equal(describeCron('not a cron'), 'not a cron');
});
