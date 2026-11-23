/** The Schedule manager's night strip: last night's runs, tonight's coming ones, and the wake marker. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nightPosition, nightStrip, nightSummaryParts, runTone} from '../src/domain/schedule/night';
import {NOW, at, facts, run, summary} from './support/schedule-fixtures';

test('a run last night is a block where it fell, as wide as it took, coloured by how it went', () => {
    /* Given */
    const runs = [
        run('a', {startedAt: at(23, 3), endedAt: at(23, 4)}),
        run('b', {startedAt: at(23, 4), endedAt: at(23, 4, 30), status: 'limit'}),
    ];

    /* When */
    const strip = nightStrip(facts({recentRuns: runs}), NOW);

    /* Then */
    assert.deepEqual(
        strip.lastNight.blocks.map((block) => [block.id, block.left, block.width, block.tone, block.planned]),
        [
            ['a', 50, 10, 'done', false],
            ['b', 60, 5, 'failed', false],
        ],
    );
});

test('a missed run shows at the time it was due, thin, and a run in the day not at all', () => {
    /* Given */
    const runs = [
        run('missed', {status: 'missed', startedAt: null, endedAt: null, dueAt: at(23, 2)}),
        run('day', {startedAt: at(23, 10), endedAt: at(23, 10, 5)}),
    ];

    /* When */
    const strip = nightStrip(facts({recentRuns: runs}), NOW);

    /* Then */
    assert.deepEqual(
        strip.lastNight.blocks.map((block) => [block.id, block.left, block.width, block.tone]),
        [['missed', 40, 1.2, 'missed']],
    );
});

test("tonight's coming runs are outlines as long as they usually take, only for schedules that are on", () => {
    /* Given */
    const schedules = [
        summary('on', {nextRunAt: at(24, 3), typicalMinutes: 30}),
        summary('off', {nextRunAt: at(24, 3), group: 'paused'}, {enabled: false}),
        summary('later', {nextRunAt: at(25, 3)}),
    ];

    /* When */
    const strip = nightStrip(facts({schedules}), NOW);

    /* Then */
    assert.deepEqual(
        strip.tonight.blocks.map((block) => [block.scheduleKey, block.left, block.width, block.planned]),
        [['on', 50, 5, true]],
    );
});

test('the wake marker stands at the Mac’s wake, and not at all for a wake in the day', () => {
    /* When */
    const night = nightStrip(facts({wakeAt: '02:55'}), NOW);
    const day = nightStrip(facts({wakeAt: '09:00'}), NOW);

    /* Then */
    assert.equal(night.wake?.at, '02:55');
    assert.equal(night.wake?.left, 49.17);
    assert.equal(day.wake, null);
});

test("last night's summary counts how its runs went and what of the week they used", () => {
    /* Given */
    const runs = [
        run('a'),
        run('b', {status: 'failed', weekBefore: 42, weekAfter: 45}),
        run('c', {trigger: 'catch-up', dueAt: at(23, 6, 30), startedAt: at(23, 7, 48), endedAt: at(23, 7, 52)}),
    ];

    /* When */
    const strip = nightStrip(facts({recentRuns: runs}), NOW);

    /* Then */
    assert.deepEqual(strip.summary, {done: 1, failed: 1, caughtUp: 1, missed: 0, weekUsed: 7});
    assert.deepEqual(nightSummaryParts(strip.summary), [
        {tone: 'done', text: '1 done'},
        {tone: 'failed', text: '1 failed'},
        {tone: 'late', text: '1 caught up late'},
    ]);
});

test('a catch-up that ran after 08:00 still counts to the night it was due in', () => {
    /* Given */
    const late = run('late', {trigger: 'catch-up', dueAt: at(23, 3), startedAt: at(23, 9), endedAt: at(23, 9, 10)});

    /* When */
    const strip = nightStrip(facts({recentRuns: [late]}), NOW);

    /* Then */
    assert.equal(strip.summary.caughtUp, 1);
    assert.equal(strip.lastNight.blocks[0]?.tone, 'late');
});

test('the axis runs 22:00 to 08:00 in two-hour steps, and positions are clamped to the track', () => {
    /* Given */
    const window = {start: at(22, 22), end: at(23, 8)};

    /* When */
    const strip = nightStrip(facts(), NOW);

    /* Then */
    assert.deepEqual(
        strip.ticks.map((tick) => `${tick.label}@${tick.left}`),
        ['22:00@0', '00:00@20', '02:00@40', '04:00@60', '06:00@80', '08:00@100'],
    );
    assert.equal(nightPosition(window, at(22, 20)), 0);
    assert.equal(nightPosition(window, at(23, 9)), 100);
    assert.equal(runTone({status: 'skipped', trigger: 'cron'}), 'skipped');
});
