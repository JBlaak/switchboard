/**
 * A schedule's When on the form: the preset and time read back from its cron,
 * the cron each preset comes to, and the check on a cron typed by hand.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    cronFromWhen,
    cronProblem,
    formatTime,
    parseTime,
    whenFromCron,
    withPreset,
    withTime,
} from '../src/domain/schedule/presets';
import type {ScheduleWhen} from '../src/domain/schedule/presets';

// ── Reading a cron ──

test('a daily cron at a set time reads as Nightly at that time', () => {
    /* When */
    const when = whenFromCron('0 3 * * *');

    /* Then */
    assert.deepEqual(when, {preset: 'nightly', hour: 3, minute: 0, day: 1, cron: '0 3 * * *'});
});

test('Monday to Friday reads as Weekdays', () => {
    /* When */
    const when = whenFromCron('30 7 * * 1-5');

    /* Then */
    assert.deepEqual(when, {preset: 'weekdays', hour: 7, minute: 30, day: 1, cron: '30 7 * * 1-5'});
});

test('one weekday reads as Weekly on that day', () => {
    /* When */
    const when = whenFromCron('0 16 * * 5');

    /* Then */
    assert.deepEqual(when, {preset: 'weekly', hour: 16, minute: 0, day: 5, cron: '0 16 * * 5'});
});

test('every hour at a minute reads as Hourly', () => {
    /* When */
    const when = whenFromCron('15 * * * *');

    /* Then */
    assert.equal(when.preset, 'hourly');
    assert.equal(when.minute, 15);
});

test('extra spaces around and between the fields still read as a preset', () => {
    /* When */
    const when = whenFromCron('  0   3 * *  * ');

    /* Then */
    assert.equal(when.preset, 'nightly');
    assert.equal(when.cron, '0 3 * * *');
});

test('crons with no preset of their shape fall back to Cron…, as written', () => {
    /* Given */
    const crons = [
        '*/15 * * * *',
        '0 3 1 * *',
        '0 3 * 6 *',
        '0 3,15 * * *',
        '0 9 * * 1,3',
        '0 9 * * 6-7',
        '0 9 * * 7',
        '0 * * * 1',
        '0 24 * * *',
        'nonsense',
        '',
    ];

    /* When */
    const presets = crons.map((cron) => whenFromCron(cron).preset);

    /* Then */
    assert.deepEqual(
        presets,
        crons.map(() => 'cron'),
    );
});

test('Cron… keeps the expression exactly as it was given', () => {
    /* When */
    const when = whenFromCron('*/15 9-17 * * 1-5');

    /* Then */
    assert.equal(cronFromWhen(when), '*/15 9-17 * * 1-5');
});

// ── Round trips ──

test('every preset comes back as itself from the cron it makes', () => {
    /* Given */
    const whens: ScheduleWhen[] = [
        {preset: 'nightly', hour: 3, minute: 0, day: 1, cron: '0 3 * * *'},
        {preset: 'weekdays', hour: 8, minute: 45, day: 1, cron: '45 8 * * 1-5'},
        {preset: 'weekly', hour: 6, minute: 30, day: 0, cron: '30 6 * * 0'},
        {preset: 'weekly', hour: 23, minute: 59, day: 6, cron: '59 23 * * 6'},
        {preset: 'hourly', hour: 3, minute: 5, day: 1, cron: '5 * * * *'},
        {preset: 'cron', hour: 3, minute: 0, day: 1, cron: '*/10 * * * *'},
    ];

    /* When */
    const back = whens.map((when) => whenFromCron(cronFromWhen(when)));

    /* Then */
    assert.deepEqual(back, whens);
});

// ── Editing ──

test('switching preset keeps the time and moves the cron along', () => {
    /* Given */
    const nightly = whenFromCron('30 2 * * *');

    /* When */
    const weekly = withPreset(nightly, 'weekly');

    /* Then */
    assert.deepEqual(weekly, {preset: 'weekly', hour: 2, minute: 30, day: 1, cron: '30 2 * * 1'});
});

test('switching to Cron… starts from the expression the preset came to', () => {
    /* Given */
    const weekdays = whenFromCron('0 9 * * 1-5');

    /* When */
    const raw = withPreset(weekdays, 'cron');

    /* Then */
    assert.equal(raw.preset, 'cron');
    assert.equal(raw.cron, '0 9 * * 1-5');
});

test('a new time changes the cron', () => {
    /* Given */
    const nightly = whenFromCron('0 3 * * *');

    /* When */
    const later = withTime(nightly, '04:15');

    /* Then */
    assert.equal(later.cron, '15 4 * * *');
});

test('a time that is not one leaves the When alone', () => {
    /* Given */
    const nightly = whenFromCron('0 3 * * *');

    /* When */
    const same = withTime(nightly, '25:00');

    /* Then */
    assert.equal(same, nightly);
});

test('times format zero-padded and parse with one or two hour digits', () => {
    /* When */
    const text = formatTime(3, 5);
    const parsed = [parseTime('3:05'), parseTime('23:59'), parseTime('24:00'), parseTime('3pm')];

    /* Then */
    assert.equal(text, '03:05');
    assert.deepEqual(parsed, [{hour: 3, minute: 5}, {hour: 23, minute: 59}, null, null]);
});

// ── Checking a cron ──

test('crons the scheduler can match pass the check', () => {
    /* Given */
    const crons = ['0 3 * * *', '*/15 * * * *', '0 9-17 * * 1-5', '0,30 8 1,15 1-12 0,6'];

    /* When */
    const problems = crons.map(cronProblem);

    /* Then */
    assert.deepEqual(
        problems,
        crons.map(() => null),
    );
});

test('a cron with the wrong number of fields says how many it needs', () => {
    /* When */
    const problem = cronProblem('0 3 * *');

    /* Then */
    assert.equal(problem, 'Five fields: minute, hour, day of the month, month, weekday');
});

test('a value out of its field’s range names the field', () => {
    /* When */
    const problems = [cronProblem('60 3 * * *'), cronProblem('0 24 * * *'), cronProblem('0 3 * * 7')];

    /* Then */
    assert.deepEqual(problems, [
        'Minute must be * or a number from 0 to 59',
        'Hour must be * or a number from 0 to 23',
        'Weekday must be * or a number from 0 to 6',
    ]);
});

test('names and stepped ranges, which the scheduler never matches, are refused', () => {
    /* When */
    const problems = [cronProblem('0 3 * * MON'), cronProblem('0 9-17/2 * * *'), cronProblem('*/0 * * * *')];

    /* Then */
    assert.ok(problems.every((problem) => problem !== null));
});
