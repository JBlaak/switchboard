/**
 * The Schedule manager's page from schedule files and runs: each schedule's
 * group, its strip and typical run, a schedule's stats, the overview's order
 * and the suggested wake.
 */
process.env.TZ = 'Europe/Amsterdam';

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    managerFacts,
    orderSummaries,
    scheduleDetail,
    scheduleGroup,
    scheduleSummary,
    startOfWeek,
    suggestedWakeAt,
    typicalMinutes,
    typicalWeekShare,
} from '../src/domain/schedule/page';
import type {ScheduleFileFacts} from '../src/domain/schedule/page';
import type {ScheduleRun, ScheduleSettings, ScheduleSummary} from '../src/domain/schedule/manager';

const MIN = 60_000;
const NOW = new Date(2026, 10, 25, 14, 0).getTime(); // Wednesday 25 November 2026

const SETTINGS: ScheduleSettings = {
    name: 'Nightly check',
    slug: 'nightly-check',
    projectPath: '/Users/me/code/app',
    cron: '0 3 * * *',
    enabled: true,
    prompt: 'Check.',
    model: null,
    permissionMode: 'acceptEdits',
    allowedTools: 'Read',
    limitMinutes: 30,
    weekCap: 80,
    missed: 'run-once',
    worktree: true,
};

function file(
    fields: Omit<Partial<ScheduleFileFacts>, 'settings'> & {settings?: Partial<ScheduleSettings>} = {},
): ScheduleFileFacts {
    return {
        key: fields.key ?? '/Users/me/code/app/.claude/commands/schedule-nightly-check.md',
        settings: {...SETTINGS, ...fields.settings},
        runsOn: fields.runsOn ?? {kind: 'mac'},
        isNew: fields.isNew ?? false,
    };
}

let seq = 0;
function run(fields: Partial<ScheduleRun> = {}): ScheduleRun {
    const startedAt = fields.startedAt === undefined ? NOW - 60 * MIN : fields.startedAt;
    return {
        id: `run-${++seq}`,
        scheduleKey: file().key,
        sessionId: 'session',
        trigger: 'cron',
        dueAt: startedAt,
        startedAt,
        endedAt: startedAt === null ? null : startedAt + 10 * MIN,
        status: 'done',
        reason: null,
        promptVersion: 1,
        report: 'Done.',
        weekBefore: 10,
        weekAfter: 12,
        worktree: null,
        seen: true,
        ...fields,
    };
}

function summary(fields: Partial<ScheduleSummary>): ScheduleSummary {
    return {...scheduleSummary({file: file(), runs: [], running: false, promptVersion: 1, now: NOW}), ...fields};
}

test('a failed run not seen yet puts its schedule under Needs you', () => {
    /* When */
    const group = scheduleGroup(file(), run({status: 'failed', seen: false}), false);

    /* Then */
    assert.equal(group, 'needsYou');
});

test('a failed run the user has seen leaves its schedule Scheduled', () => {
    /* When */
    const group = scheduleGroup(file(), run({status: 'failed', seen: true}), false);

    /* Then */
    assert.equal(group, 'scheduled');
});

test('a run the week cap skipped needs you, one the user skipped does not', () => {
    /* When */
    const capped = scheduleGroup(file(), run({status: 'skipped', reason: 'the week was past 80%', seen: false}), false);
    const skipped = scheduleGroup(
        file(),
        run({status: 'skipped', reason: 'you pressed Skip tonight', seen: false}),
        false,
    );

    /* Then */
    assert.equal(capped, 'needsYou');
    assert.equal(skipped, 'scheduled');
});

test('a running schedule is Running, an off one Paused, a new one New', () => {
    /* When */
    const running = scheduleGroup(file(), run({status: 'done'}), true);
    const paused = scheduleGroup(file({settings: {enabled: false}}), null, false);
    const fresh = scheduleGroup(file({isNew: true}), null, false);

    /* Then */
    assert.equal(running, 'running');
    assert.equal(paused, 'paused');
    assert.equal(fresh, 'new');
});

test('the summary shows the last 14 runs oldest first and the next time', () => {
    /* Given: 20 runs, newest first */
    const runs = Array.from({length: 20}, (_, i) =>
        run({startedAt: NOW - (i + 1) * 24 * 60 * MIN, status: i === 0 ? 'failed' : 'done', seen: true}),
    );

    /* When */
    const result = scheduleSummary({file: file(), runs, running: false, promptVersion: 3, now: NOW});

    /* Then */
    assert.equal(result.lastRuns.length, 14);
    assert.equal(result.lastRuns[13], 'failed');
    assert.equal(result.last, runs[0]);
    assert.equal(result.nextRunAt, new Date(2026, 10, 26, 3, 0).getTime());
    assert.equal(result.promptVersion, 3);
});

test('a paused or new schedule has no next time', () => {
    /* When */
    const paused = scheduleSummary({
        file: file({settings: {enabled: false}}),
        runs: [],
        running: false,
        promptVersion: 1,
        now: NOW,
    });
    const fresh = scheduleSummary({file: file({isNew: true}), runs: [], running: false, promptVersion: 0, now: NOW});

    /* Then */
    assert.equal(paused.nextRunAt, null);
    assert.equal(fresh.nextRunAt, null);
});

test('a typical run is the median over finished runs only', () => {
    /* Given */
    const runs = [
        run({startedAt: NOW - 100 * MIN, endedAt: NOW - 90 * MIN, weekBefore: 10, weekAfter: 11}),
        run({startedAt: NOW - 200 * MIN, endedAt: NOW - 170 * MIN, weekBefore: 20, weekAfter: 24, status: 'limit'}),
        run({startedAt: NOW - 300 * MIN, endedAt: NOW - 280 * MIN, weekBefore: 30, weekAfter: 32, status: 'failed'}),
        run({status: 'running', endedAt: null, weekAfter: null}),
        run({status: 'missed', startedAt: null, weekBefore: null, weekAfter: null}),
    ];

    /* When */
    const minutes = typicalMinutes(runs);
    const share = typicalWeekShare(runs);

    /* Then */
    assert.equal(minutes, 20);
    assert.equal(share, 2);
});

test('a week that reset mid-run counts as no share rather than a negative one', () => {
    /* When */
    const share = typicalWeekShare([run({weekBefore: 90, weekAfter: 3})]);

    /* Then */
    assert.equal(share, 0);
});

test('without finished runs there is no typical run', () => {
    /* When */
    const minutes = typicalMinutes([run({status: 'skipped', startedAt: null})]);

    /* Then */
    assert.equal(minutes, null);
});

test('a schedule’s stats count every run, list the newest 50, and add up this week', () => {
    /* Given: newest first; this week began on Monday 23 November */
    const runs = [
        run({startedAt: NOW - 60 * MIN, weekBefore: 10, weekAfter: 13}),
        run({startedAt: NOW - 24 * 60 * MIN, weekBefore: 5, weekAfter: 6.5, trigger: 'catch-up'}),
        run({startedAt: NOW - 3 * 24 * 60 * MIN, status: 'failed', weekBefore: 50, weekAfter: 54}),
        ...Array.from({length: 60}, (_, i) => run({startedAt: NOW - (10 + i) * 24 * 60 * MIN})),
    ];
    const versions = [{version: 2, text: 'Check.', savedAt: NOW, note: null}];

    /* When */
    const detail = scheduleDetail(summary({}), runs, versions, NOW);

    /* Then */
    assert.equal(detail.runs.length, 50);
    assert.equal(detail.stats.total, 63);
    assert.equal(detail.stats.done, 62);
    assert.equal(detail.stats.failed, 1);
    assert.equal(detail.stats.caughtUp, 1);
    assert.equal(detail.stats.since, NOW - 69 * 24 * 60 * MIN);
    assert.equal(detail.stats.thisWeekShare, 4.5);
    assert.equal(detail.versions, versions);
});

test('a schedule with no runs this week used none of it', () => {
    /* When */
    const detail = scheduleDetail(summary({}), [run({startedAt: NOW - 10 * 24 * 60 * MIN})], [], NOW);

    /* Then */
    assert.equal(detail.stats.thisWeekShare, 0);
});

test('the week starts on Monday at midnight', () => {
    /* When */
    const start = startOfWeek(NOW);

    /* Then */
    assert.equal(start, new Date(2026, 10, 23, 0, 0).getTime());
});

test('the overview lists Needs you, Running, Scheduled by next time, New, then Paused', () => {
    /* Given */
    const named = (name: string, fields: Partial<ScheduleSummary>): ScheduleSummary =>
        summary({...fields, key: name, settings: {...SETTINGS, name}});
    const summaries = [
        named('paused', {group: 'paused', nextRunAt: null}),
        named('later', {group: 'scheduled', nextRunAt: NOW + 5 * MIN}),
        named('new', {group: 'new', nextRunAt: null}),
        named('sooner', {group: 'scheduled', nextRunAt: NOW + MIN}),
        named('running', {group: 'running'}),
        named('failed', {group: 'needsYou'}),
    ];

    /* When */
    const order = orderSummaries(summaries).map((s) => s.key);

    /* Then */
    assert.deepEqual(order, ['failed', 'running', 'sooner', 'later', 'new', 'paused']);
});

test('the suggested wake is five minutes before the earliest nightly run on this Mac', () => {
    /* Given */
    const files = [
        file({settings: {cron: '20 3 * * *'}}),
        file({settings: {cron: '0 2 * * *'}, runsOn: {kind: 'vm', host: 'buildbox'}}),
        file({settings: {cron: '0 1 * * *', enabled: false}}),
        file({settings: {cron: '0 0 * * *'}, isNew: true}),
        file({settings: {cron: '45 2 * * 1-5'}}),
        file({settings: {cron: '0 9 * * *'}}),
    ];

    /* When */
    const wake = suggestedWakeAt(files);

    /* Then */
    assert.equal(wake, '02:40');
});

test('no nightly run suggests no wake', () => {
    /* When */
    const wake = suggestedWakeAt([file({settings: {cron: '0 9 * * *'}})]);

    /* Then */
    assert.equal(wake, null);
});

test('the facts carry the ordered schedules, the runs, the wake and the week', () => {
    /* Given */
    const recent = [run({})];

    /* When */
    const facts = managerFacts({
        summaries: [summary({group: 'paused', key: 'b'}), summary({group: 'needsYou', key: 'a'})],
        files: [file({settings: {cron: '10 0 * * *'}})],
        recentRuns: recent,
        wakeAt: '02:55',
        week: 41,
    });

    /* Then */
    assert.deepEqual(
        facts.schedules.map((s) => s.key),
        ['a', 'b'],
    );
    assert.equal(facts.recentRuns, recent);
    assert.equal(facts.wakeAt, '02:55');
    assert.equal(facts.suggestedWakeAt, '00:05');
    assert.equal(facts.week, 41);
});
