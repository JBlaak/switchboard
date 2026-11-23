/** What the Schedule manager's page shows of its facts: groups, the header, the wake offer, pills, rows and the figure. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    headerLine,
    overviewGroups,
    overviewOrder,
    reportLine,
    rowSideText,
    runPill,
    runsOnText,
    scheduleFigureOf,
    scheduleFile,
    stepKey,
    wakeOffer,
} from '../src/domain/schedule/page-view';
import {tunePrompt} from '../src/domain/schedule/tune-prompt';
import {MIN, NOW, at, facts, run, summary} from './support/schedule-fixtures';

test('the groups come Needs you, Scheduled, New, Paused, with running schedules first among the scheduled', () => {
    /* Given */
    const schedules = [
        summary('paused', {group: 'paused'}),
        summary('later', {nextRunAt: at(25, 3)}),
        summary('sooner', {nextRunAt: at(24, 3)}),
        summary('new', {group: 'new'}),
        summary('running', {group: 'running', nextRunAt: at(30, 3)}),
        summary('older trouble', {group: 'needsYou', last: run('x', {endedAt: at(22, 3)})}),
        summary('newer trouble', {group: 'needsYou', last: run('y', {endedAt: at(23, 3)})}),
    ];

    /* When */
    const groups = overviewGroups(schedules);

    /* Then */
    assert.deepEqual(
        groups.map((group) => [group.id, group.schedules.map((schedule) => schedule.key)]),
        [
            ['needsYou', ['newer trouble', 'older trouble']],
            ['scheduled', ['running', 'sooner', 'later']],
            ['new', ['new']],
            ['paused', ['paused']],
        ],
    );
});

test('J/K go through the groups top to bottom, Paused only while it is shown, and stop at the ends', () => {
    /* Given */
    const groups = overviewGroups([summary('a'), summary('b', {group: 'paused'})]);

    /* When */
    const folded = overviewOrder(groups, false);
    const shown = overviewOrder(groups, true);

    /* Then */
    assert.deepEqual(folded, ['a']);
    assert.deepEqual(shown, ['a', 'b']);
    assert.equal(stepKey(shown, null, 1), 'a');
    assert.equal(stepKey(shown, null, -1), 'b');
    assert.equal(stepKey(shown, 'b', 1), 'b');
    assert.equal(stepKey(shown, 'b', -1), 'a');
    assert.equal(stepKey([], null, 1), null);
});

test("the header counts schedules, projects and tonight's runs, and says the wake and the week", () => {
    /* Given */
    const schedules = [
        summary('a', {nextRunAt: at(24, 3)}, {projectPath: '/p/one'}),
        summary('b', {nextRunAt: at(24, 4)}, {projectPath: '/p/one'}),
        summary('c', {nextRunAt: at(26, 9)}, {projectPath: '/p/two'}),
    ];

    /* When */
    const line = headerLine(facts({schedules, wakeAt: '02:55', week: 43.6}), NOW);
    const unset = headerLine(facts({schedules: [schedules[2]], suggestedWakeAt: '02:55'}), NOW);

    /* Then */
    assert.equal(line, '3 schedules in 2 projects · 2 run tonight · Mac set to wake at 02:55 · week at 44%');
    assert.equal(unset, '1 schedule in 1 project · Mac not set to wake');
});

test('the wake is offered while the Mac is not set to the suggested one', () => {
    /* When */
    const offers = [
        wakeOffer({wakeAt: null, suggestedWakeAt: '02:55'}),
        wakeOffer({wakeAt: '04:00', suggestedWakeAt: '02:55'}),
        wakeOffer({wakeAt: '02:55', suggestedWakeAt: '02:55'}),
        wakeOffer({wakeAt: null, suggestedWakeAt: null}),
    ];

    /* Then */
    assert.deepEqual(offers, ['02:55', '02:55', null, null]);
});

test('a run that asks for a look has a pill; a plain done or skipped one has none', () => {
    /* When */
    const pills = [
        runPill({status: 'limit', trigger: 'cron'}),
        runPill({status: 'failed', trigger: 'cron'}),
        runPill({status: 'missed', trigger: 'cron'}),
        runPill({status: 'done', trigger: 'catch-up'}),
        runPill({status: 'done', trigger: 'cron'}),
        runPill({status: 'skipped', trigger: 'cron'}),
    ];

    /* Then */
    assert.deepEqual(pills, [
        {text: 'TIME LIMIT', tone: 'failed'},
        {text: 'FAILED', tone: 'failed'},
        {text: 'MISSED', tone: 'missed'},
        {text: 'CAUGHT UP LATE', tone: 'late'},
        null,
        null,
    ]);
});

test("a compact row says its next run and its last report's first line, or how far a running one is", () => {
    /* Given */
    const quiet = summary('a', {nextRunAt: at(24, 3, 20), last: run('r', {report: '## Nothing new\n\nNo errors.'})});
    const running = summary('b', {last: run('s', {status: 'running', startedAt: NOW - 6 * MIN, endedAt: null})});
    const never = summary('c', {nextRunAt: null, last: null}, {enabled: false});

    /* When */
    const said = [quiet, running, never].map((schedule) => rowSideText(schedule, NOW));

    /* Then */
    assert.deepEqual(said, ['tonight 03:20 · Nothing new', 'running now, 6 min in', 'not run yet']);
});

test('a report line is cut to fit, and an empty report says nothing', () => {
    /* When */
    const lines = [reportLine('- ✓ ' + 'x'.repeat(60), 10), reportLine('  \n'), reportLine(null)];

    /* Then */
    assert.deepEqual(lines, ['xxxxxxxxx…', null, null]);
});

test('where a schedule runs, and its file and slash command', () => {
    /* When */
    const where = [runsOnText({kind: 'mac'}), runsOnText({kind: 'vm', host: 'devbox'})];
    const file = scheduleFile('/p/web/.claude/commands/schedule-sweep.md', '/p/web');

    /* Then */
    assert.deepEqual(where, ['this Mac', 'VM devbox']);
    assert.deepEqual(file, {path: '.claude/commands/schedule-sweep.md', command: '/schedule-sweep'});
});

test('the figure runs while a run goes, needs you with the count of schedules that do, and is calm otherwise', () => {
    /* Given */
    const trouble = summary('a', {group: 'needsYou'});

    /* When */
    const poses = [
        scheduleFigureOf(null),
        scheduleFigureOf(facts({schedules: [summary('b')]})),
        scheduleFigureOf(facts({schedules: [trouble, summary('c', {group: 'needsYou'})]})),
        scheduleFigureOf(facts({schedules: [trouble, summary('d', {group: 'running'})]})),
    ];

    /* Then */
    assert.deepEqual(poses, [
        {pose: 'calm', count: 0},
        {pose: 'calm', count: 0},
        {pose: 'needsYou', count: 2},
        {pose: 'running', count: 1},
    ]);
});

test("tuning from a run names the schedule's file, the run's session and its report", () => {
    /* Given */
    const failed = run('r', {
        status: 'limit',
        reason: 'its 20 min limit',
        report: 'Two PRs.\nOne left.',
        promptVersion: 3,
    });

    /* When */
    const prompt = tunePrompt('/p/.claude/commands/schedule-a.md', 'Sweep', failed);

    /* Then */
    assert.match(prompt, /schedule "Sweep", saved in \/p\/\.claude\/commands\/schedule-a\.md/);
    assert.match(prompt, /time limit \(its 20 min limit\), with prompt v3/);
    assert.match(prompt, /session session-r/);
    assert.match(prompt, /> Two PRs\.\n> One left\./);
    assert.match(prompt, /Keep the frontmatter as it is/);
});
