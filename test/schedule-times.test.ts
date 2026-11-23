/** The Schedule manager's times: when a run comes, how far off, when one was, how long and how much of the week. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    editedText,
    lastNightWindow,
    minutesText,
    nextRunText,
    runWhen,
    shareText,
    tonightWindow,
    untilText,
} from '../src/domain/schedule/times';
import {NOW, at} from './support/schedule-fixtures';

test('a run tonight, tomorrow, later this week and further off', () => {
    /* When */
    const said = [at(24, 3), at(23, 23), at(23, 18), at(24, 9), at(27, 6, 30), at(3 + 30, 3)].map((when) =>
        nextRunText(when, NOW),
    );

    /* Then */
    assert.deepEqual(said, [
        'tonight 03:00',
        'tonight 23:00',
        'today 18:00',
        'tomorrow 09:00',
        'Fri 06:30',
        '3 Dec 03:00',
    ]);
});

test('in the small hours, the night going now is tonight', () => {
    /* When */
    const said = nextRunText(at(23, 4), at(23, 2));

    /* Then */
    assert.equal(said, 'tonight 04:00');
});

test('how far off a run is', () => {
    /* When */
    const said = [NOW + 30_000, NOW + 40 * 60_000, at(24, 5), at(26, 14)].map((when) => untilText(when, NOW));

    /* Then */
    assert.deepEqual(said, ['now', 'in 40 min', 'in 15 h', 'in 3 days']);
});

test("last night's run says so, an older one its day and time", () => {
    /* When */
    const said = [
        runWhen(at(23, 3), NOW),
        runWhen(at(21, 3), NOW),
        runWhen(at(23, 9, 5), NOW),
        runWhen(at(10, 3), NOW),
    ];

    /* Then */
    assert.deepEqual(said, [
        {title: 'Last night', sub: 'Mon 03:00'},
        {title: 'Sat 03:00', sub: null},
        {title: 'Today 09:05', sub: null},
        {title: '10 Nov 03:00', sub: null},
    ]);
});

test("tonight's and last night's windows run from 22:00 to 08:00", () => {
    /* When */
    const tonight = tonightWindow(NOW);
    const last = lastNightWindow(NOW);
    const duringTheNight = tonightWindow(at(24, 3));

    /* Then */
    assert.deepEqual(tonight, {start: at(23, 22), end: at(24, 8)});
    assert.deepEqual(last, {start: at(22, 22), end: at(23, 8)});
    assert.deepEqual(duringTheNight, tonight);
});

test('lengths, shares of the week and when the prompt was edited', () => {
    /* When */
    const lengths = [0.4, 23, 65, 120].map(minutesText);
    const shares = [0.3, 2.6].map(shareText);
    const edited = [at(23, 9), at(22, 9), at(19, 16), at(2, 9)].map((when) => editedText(when, NOW));

    /* Then */
    assert.deepEqual(lengths, ['<1 min', '23 min', '1 h 5 min', '2 h']);
    assert.deepEqual(shares, ['<1%', '~3%']);
    assert.deepEqual(edited, ['edited today', 'edited yesterday', 'edited Thu', 'edited 2 Nov']);
});
