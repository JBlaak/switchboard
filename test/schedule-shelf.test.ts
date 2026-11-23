/** Scheduled runs on the Automatic shelf: which runs it lists, what each says, and what comes up next. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    anyScheduleOn,
    comingUp,
    listedRuns,
    nextScheduledAt,
    reportLine,
    runStatusText,
    upcomingTime,
} from '../src/domain/schedule/shelf';
import {facts, local, run, schedule} from './support/schedule-shelf-fixtures';

// ── Which runs are listed ──

test('a running run and an ended one not seen yet are listed; a seen one is not', () => {
    /* Given */
    const world = facts(
        [schedule('a')],
        [run('going', 'a', {status: 'running', endedAt: null}), run('unread', 'a'), run('read', 'a', {seen: true})],
    );

    /* When */
    const ids = listedRuns(world).map((r) => r.id);

    /* Then */
    assert.deepEqual(ids.sort(), ['going', 'unread']);
});

test('listed runs come newest first, by when they ended, else started, else were due', () => {
    /* Given */
    const world = facts(
        [schedule('a')],
        [
            run('early', 'a', {endedAt: local(2)}),
            run('late', 'a', {endedAt: local(5)}),
            run('missed', 'a', {status: 'missed', sessionId: null, startedAt: null, endedAt: null, dueAt: local(4)}),
        ],
    );

    /* When */
    const ids = listedRuns(world).map((r) => r.id);

    /* Then */
    assert.deepEqual(ids, ['late', 'missed', 'early']);
});

test('a run that failed, hit its limit or was missed needs you; one that finished does not', () => {
    /* Given */
    const world = facts(
        [schedule('a')],
        [
            run('failed', 'a', {status: 'failed'}),
            run('limit', 'a', {status: 'limit'}),
            run('missed', 'a', {status: 'missed', sessionId: null}),
            run('done', 'a'),
            run('skipped', 'a', {status: 'skipped', sessionId: null}),
            run('going', 'a', {status: 'running'}),
        ],
    );

    /* When */
    const needsYou = Object.fromEntries(listedRuns(world).map((r) => [r.id, r.needsYou]));

    /* Then */
    assert.deepEqual(needsYou, {failed: true, limit: true, missed: true, done: false, skipped: false, going: false});
});

test('a run is named after its schedule and runs where it does', () => {
    /* Given */
    const world = facts(
        [schedule('a', {settings: {name: 'Bugsnag sweep'}, runsOn: {kind: 'vm', host: 'build-vm'}})],
        [run('r', 'a')],
    );

    /* When */
    const [listed] = listedRuns(world);

    /* Then */
    assert.equal(listed.name, 'Bugsnag sweep');
    assert.equal(listed.host, 'build-vm');
    assert.equal(listed.projectPath, '/Users/me/dev/switchboard');
});

test('a run whose schedule has gone is still listed, as a scheduled run', () => {
    /* Given */
    const world = facts([], [run('r', 'gone')]);

    /* When */
    const [listed] = listedRuns(world);

    /* Then */
    assert.equal(listed.name, 'Scheduled run');
});

test('a running run says the time it was due, an ended one what became of it', () => {
    /* Given */
    const world = facts(
        [schedule('a')],
        [
            run('going', 'a', {status: 'running', dueAt: local(3, 20), endedAt: null}),
            run('limit', 'a', {status: 'limit', endedAt: local(4)}),
            run('failed', 'a', {status: 'failed', endedAt: local(3, 59)}),
            run('done', 'a', {report: '## Draft updated\n\nThe release notes now cover #514.', endedAt: local(3, 58)}),
            run('quiet', 'a', {report: null, endedAt: local(3, 57)}),
        ],
    );

    /* When */
    const doing = listedRuns(world).map((r) => r.doing);

    /* Then */
    assert.deepEqual(doing, ['limit hit', 'failed', 'Draft updated', 'done', '03:20']);
});

test('a report’s first line loses its Markdown marks and is cut to fit', () => {
    /* When */
    const lines = [
        reportLine('\n\n- **2 PRs** opened'),
        reportLine('A very long first line that goes on and on past what fits on a row'),
        reportLine('   '),
    ];

    /* Then */
    assert.deepEqual(lines, ['2 PRs opened', 'A very long first line that goes on and…', null]);
});

// ── Coming up ──

test('coming up are the next two times of schedules that are on, within 12 hours, soonest first', () => {
    /* Given */
    const now = local(22);
    const world = facts([
        schedule('notes', {settings: {name: 'Release notes'}, nextRunAt: local(4, 0, 24)}),
        schedule('sweep', {settings: {name: 'Bugsnag sweep'}, nextRunAt: local(3, 0, 24)}),
        schedule('hours', {settings: {name: 'Log my hours'}, nextRunAt: local(6, 30, 24)}),
        schedule('off', {settings: {enabled: false}, nextRunAt: local(23)}),
        schedule('far', {nextRunAt: local(12, 0, 24)}),
    ]);

    /* When */
    const next = comingUp(world, now);

    /* Then */
    assert.deepEqual(next, [
        {scheduleKey: 'sweep', name: 'Bugsnag sweep', at: local(3, 0, 24)},
        {scheduleKey: 'notes', name: 'Release notes', at: local(4, 0, 24)},
    ]);
});

test('the next time is the soonest of the schedules that are on, however far', () => {
    /* Given */
    const world = facts([
        schedule('off', {settings: {enabled: false}, nextRunAt: local(1, 0, 24)}),
        schedule('weekly', {nextRunAt: local(3, 0, 30)}),
        schedule('never', {nextRunAt: null}),
    ]);

    /* When */
    const next = nextScheduledAt(world, local(12));

    /* Then */
    assert.equal(next, local(3, 0, 30));
});

test('a time within a day reads as a clock, one further away with its weekday', () => {
    /* Given */
    const now = local(12);

    /* When */
    const times = [upcomingTime(local(3, 0, 24), now), upcomingTime(local(3, 0, 30), now)];

    /* Then */
    assert.deepEqual(times, ['03:00', 'Mon 03:00']);
});

test('the shelf stays while a schedule is on, and not for schedules that are all off', () => {
    /* Given */
    const on = facts([schedule('a'), schedule('b', {settings: {enabled: false}})]);
    const off = facts([schedule('b', {settings: {enabled: false}})]);

    /* When */
    const answers = [anyScheduleOn(on), anyScheduleOn(off), anyScheduleOn(null)];

    /* Then */
    assert.deepEqual(answers, [true, false, false]);
});

// ── The header's words ──

test('the header says how a run went, with its reason when it has one', () => {
    /* Given */
    const world = facts(
        [schedule('a')],
        [
            run('going', 'a', {status: 'running', startedAt: local(3, 1), endedAt: local(9)}),
            run('done', 'a', {endedAt: local(3, 14)}),
            run('limit', 'a', {status: 'limit', endedAt: local(3, 20), reason: 'its 20 min limit'}),
            run('missed', 'a', {status: 'missed', reason: 'the Mac was asleep at 03:00', endedAt: local(2)}),
        ],
    );

    /* When */
    const texts = Object.fromEntries(listedRuns(world).map((r) => [r.id, runStatusText(r)]));

    /* Then */
    assert.deepEqual(texts, {
        going: 'running since 03:01',
        done: 'done at 03:14',
        limit: 'stopped at 03:20 · its 20 min limit',
        missed: 'missed · the Mac was asleep at 03:00',
    });
});
