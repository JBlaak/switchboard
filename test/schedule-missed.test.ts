import {test} from 'node:test';
import assert from 'node:assert/strict';

import {cronMatches, latestCronTime} from '../src/domain/schedule/cron';
import {catchUpReason, MISSED_WINDOW_MS, missedDecision, missedReason} from '../src/domain/schedule/missed';

/**
 * The cron times the Mac slept through: the latest one in the last week, and
 * what a schedule does about it. Local times, as the tick matches them.
 */

const at = (day: number, hour: number, minute = 0, second = 0) =>
    new Date(2026, 10, day, hour, minute, second).getTime();

test('the latest cron time is the last matching minute at or before now', () => {
    /* Given */
    const now = at(3, 7, 30, 15);

    /* When */
    const nightly = latestCronTime('0 3 * * *', now, MISSED_WINDOW_MS);
    const quarterly = latestCronTime('*/15 * * * *', now, MISSED_WINDOW_MS);
    const thisMinute = latestCronTime('30 7 * * *', now, MISSED_WINDOW_MS);

    /* Then */
    assert.equal(nightly, at(3, 3));
    assert.equal(quarterly, at(3, 7, 30));
    assert.equal(thisMinute, at(3, 7, 30));
});

test('the latest cron time steps back over days that do not match', () => {
    /* Given: Tuesday 3 November 2026, 07:00 */
    const now = at(3, 7);

    /* When */
    const fridays = latestCronTime('30 22 * * 5', now, MISSED_WINDOW_MS);
    const firstOfMonth = latestCronTime('0 9 1 * *', now, MISSED_WINDOW_MS);

    /* Then */
    assert.equal(fridays, new Date(2026, 9, 30, 22, 30).getTime());
    assert.equal(firstOfMonth, at(1, 9));
});

test('nothing in the window, or a broken cron, answers null', () => {
    /* Given */
    const now = at(3, 7);

    /* When */
    const yearly = latestCronTime('0 3 1 1 *', now, MISSED_WINDOW_MS);
    const broken = latestCronTime('0 3 * *', now, MISSED_WINDOW_MS);
    const outsideShortWindow = latestCronTime('0 3 * * *', now, 60 * 60_000);

    /* Then */
    assert.deepEqual([yearly, broken, outsideShortWindow], [null, null, null]);
});

test('every minute of a week is walked when the cron matches none of them, in few steps per day', () => {
    /* Given: a minute that never comes */
    const now = at(3, 7);

    /* When */
    const started = performance.now();
    const found = latestCronTime('61 * * * *', now, MISSED_WINDOW_MS);
    const ms = performance.now() - started;

    /* Then */
    assert.equal(found, null);
    assert.ok(ms < 200, `took ${ms} ms`);
});

test('the latest time agrees with cronMatches', () => {
    /* Given */
    const now = at(3, 7, 12);

    /* When */
    const found = latestCronTime('5,40 */2 * * 1-5', now, MISSED_WINDOW_MS);

    /* Then */
    assert.equal(found, at(3, 6, 40));
    assert.ok(cronMatches('5,40 */2 * * 1-5', new Date(found ?? 0)));
});

test('a run-once schedule catches up its latest unrun time; a skip one records it missed', () => {
    /* Given */
    const base = {cron: '0 3 * * *', now: at(3, 7), firstVersionAt: at(1, 12), hasRunFor: () => false};

    /* When */
    const runOnce = missedDecision({...base, missed: 'run-once'});
    const skip = missedDecision({...base, missed: 'skip'});

    /* Then */
    assert.deepEqual(runOnce, {kind: 'catch-up', dueAt: at(3, 3)});
    assert.deepEqual(skip, {kind: 'missed', dueAt: at(3, 3)});
});

test('nothing is owed for a time already run, one before it was turned on, or one never turned on', () => {
    /* Given */
    const base = {cron: '0 3 * * *', now: at(3, 7), missed: 'run-once' as const};

    /* When */
    const ran = missedDecision({...base, firstVersionAt: at(1, 12), hasRunFor: (due) => due === at(3, 3)});
    const tooEarly = missedDecision({...base, firstVersionAt: at(3, 4), hasRunFor: () => false});
    const neverOn = missedDecision({...base, firstVersionAt: null, hasRunFor: () => false});

    /* Then */
    assert.deepEqual([ran, tooEarly, neverOn], [{kind: 'none'}, {kind: 'none'}, {kind: 'none'}]);
});

test('the reasons say why the time was missed and when it ran', () => {
    /* When */
    const reasons = [
        missedReason('wake', at(3, 3)),
        catchUpReason('wake', at(3, 3)),
        catchUpReason('start', at(3, 3, 5)),
    ];

    /* Then */
    assert.deepEqual(reasons, [
        'the Mac was asleep at 03:00',
        'the Mac was asleep at 03:00, ran on wake',
        'Switchboard was not running at 03:05, ran on start',
    ]);
});
