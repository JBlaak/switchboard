/**
 * The Mac's repeating wake: reading it from `pmset -g sched` and the
 * `pmset repeat` arguments that set and clear it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {parseRepeatingWake, promptCancelled, repeatWakeArgs} from '../src/domain/power/wake';

test('a repeating wake reads as a 24-hour time', () => {
    /* Given */
    const output = [
        'Repeating power events:',
        '  wakepoweron at 2:55AM every day',
        'Scheduled power events:',
        " [0]  wake at 11/24/2026 03:00:00 by 'com.apple.alarm.user-invisible'",
    ].join('\n');

    /* When */
    const at = parseRepeatingWake(output);

    /* Then */
    assert.equal(at, '02:55');
});

test('an afternoon wake and one at noon and midnight read right', () => {
    /* When */
    const afternoon = parseRepeatingWake('Repeating power events:\n  wake at 1:30PM weekdays only\n');
    const noon = parseRepeatingWake('Repeating power events:\n  wakepoweron at 12:00PM every day\n');
    const midnight = parseRepeatingWake('Repeating power events:\n  wakepoweron at 12:05AM every day\n');

    /* Then */
    assert.equal(afternoon, '13:30');
    assert.equal(noon, '12:00');
    assert.equal(midnight, '00:05');
});

test('a repeating shutdown is not a wake', () => {
    /* Given */
    const output = 'Repeating power events:\n  shutdown at 11:00PM every day\n  wakepoweron at 6:15AM every day\n';

    /* When */
    const at = parseRepeatingWake(output);

    /* Then */
    assert.equal(at, '06:15');
});

test('one-off wakes other apps scheduled are not the repeating wake', () => {
    /* Given: as this Mac prints it with nothing repeating */
    const output = [
        'Scheduled power events:',
        " [0]  wake at 10/19/2026 18:41:09 by 'com.apple.alarm.user-invisible-com.apple.calaccessd'",
    ].join('\n');

    /* When */
    const at = parseRepeatingWake(output);

    /* Then */
    assert.equal(at, null);
});

test('the wake is set for every day of the week, or cancelled', () => {
    /* When */
    const set = repeatWakeArgs('02:55');
    const cleared = repeatWakeArgs(null);

    /* Then */
    assert.deepEqual(set, ['repeat', 'wakeorpoweron', 'MTWRFSU', '02:55:00']);
    assert.deepEqual(cleared, ['repeat', 'cancel']);
});

test('a time that is not HH:MM never reaches pmset', () => {
    /* Then */
    assert.throws(() => repeatWakeArgs('2:55; rm -rf /'));
    assert.throws(() => repeatWakeArgs('25:00'));
});

test('a cancelled password prompt is told from a failure', () => {
    /* Then */
    assert.equal(promptCancelled('0:89: execution error: User canceled. (-128)'), true);
    assert.equal(promptCancelled('pmset: permission denied'), false);
});
