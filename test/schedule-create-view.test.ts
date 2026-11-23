/**
 * What the create-a-schedule dialog offers: the projects, the one it starts
 * on, the copies, the slug a new name takes, and which sessions can be made a
 * schedule.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    canMakeSchedule,
    copyChoices,
    defaultProjectPath,
    localProjectChoices,
    takenSlugs,
    withNewName,
} from '../src/renderer/ui/schedule-manager/create-view';
import {blankScheduleSettings} from '../src/domain/schedule/form';
import type {Project} from '../src/domain/project/project';
import type {ScheduleSettings, ScheduleSummary} from '../src/domain/schedule/manager';

const HOME = '/Users/me';

function project(projectPath: string, extra: Partial<Project> = {}): Project {
    return {projectPath, folder: projectPath.replace(/\//g, '-'), sessions: [], ...extra};
}

function summary(name: string, slug: string, projectPath: string): ScheduleSummary {
    const settings: ScheduleSettings = {...blankScheduleSettings(projectPath), name, slug, prompt: 'Do it.'};
    return {
        key: `${projectPath}/.claude/commands/schedule-${slug}.md`,
        settings,
        runsOn: {kind: 'mac'},
        group: 'scheduled',
        nextRunAt: null,
        lastRuns: [],
        last: null,
        typicalMinutes: null,
        typicalWeekShare: null,
        promptVersion: 1,
    };
}

// ── Projects ──

test('only local repositories are offered, most recently worked in first', () => {
    /* Given */
    const projects = [
        project(`${HOME}/code/api`),
        project(`${HOME}/code/web`),
        project(`${HOME}/code/web/.claude/worktrees/fix`),
        project('ssh://me@box/srv/app', {remote: true}),
    ];
    const recency = new Map([
        [`${HOME}/code/web`, 200],
        [`${HOME}/code/api`, 100],
    ]);

    /* When */
    const choices = localProjectChoices(projects, recency);

    /* Then */
    assert.deepEqual(
        choices.map((choice) => choice.path),
        [`${HOME}/code/web`, `${HOME}/code/api`],
    );
});

test('step 1 starts on the repository of the session on screen', () => {
    /* Given */
    const choices = [
        {path: `${HOME}/code/web`, label: 'web'},
        {path: `${HOME}/code/api`, label: 'api'},
    ];

    /* When */
    const picked = defaultProjectPath(choices, `${HOME}/code/api/.claude/worktrees/fix`);

    /* Then */
    assert.equal(picked, `${HOME}/code/api`);
});

test('with no session on screen, or one elsewhere, step 1 starts on the first project', () => {
    /* Given */
    const choices = [{path: `${HOME}/code/web`, label: 'web'}];

    /* When */
    const picked = [defaultProjectPath(choices, null), defaultProjectPath(choices, 'ssh://me@box/srv/app')];

    /* Then */
    assert.deepEqual(picked, [`${HOME}/code/web`, `${HOME}/code/web`]);
});

test('with no projects there is nothing to start on', () => {
    /* When */
    const picked = defaultProjectPath([], null);

    /* Then */
    assert.equal(picked, null);
});

// ── Copies and slugs ──

test('every schedule is offered as a copy, by name', () => {
    /* Given */
    const schedules = [summary('Crashlytics watch', 'crashlytics', `${HOME}/code/web`)];

    /* When */
    const copies = copyChoices(schedules);

    /* Then */
    assert.deepEqual(copies, [{key: schedules[0].key, label: 'Copy of Crashlytics watch…'}]);
});

test('the slugs taken are those of the schedules in the same project', () => {
    /* Given */
    const schedules = [summary('Sweep', 'sweep', `${HOME}/code/web`), summary('Notes', 'notes', `${HOME}/code/api`)];

    /* When */
    const taken = takenSlugs(schedules, `${HOME}/code/web`);

    /* Then */
    assert.deepEqual([...taken], ['sweep']);
});

test('renaming a new schedule moves its slug to a free one', () => {
    /* Given */
    const before = {...blankScheduleSettings(HOME), name: 'Sweep', slug: 'sweep'};

    /* When */
    const after = withNewName(before, {...before, name: 'Nightly sweep'}, new Set(['nightly-sweep']));

    /* Then */
    assert.equal(after.slug, 'nightly-sweep-2');
});

test('an edit that keeps the name keeps the slug Claude drafted', () => {
    /* Given */
    const before = {...blankScheduleSettings(HOME), name: 'Bugsnag sweep', slug: 'bugsnag'};
    const next = {...before, cron: '0 4 * * *'};

    /* When */
    const after = withNewName(before, next, new Set());

    /* Then */
    assert.equal(after, next);
});

// ── Make this a schedule ──

test('a local Claude session in a project can be made a schedule', () => {
    /* When */
    const can = canMakeSchedule({type: 'claude', projectPath: `${HOME}/code/web`});

    /* Then */
    assert.equal(can, true);
});

test('terminals, remote and VM sessions, and sessions with no project cannot', () => {
    /* When */
    const can = [
        canMakeSchedule({type: 'terminal', projectPath: `${HOME}/code/web`}),
        canMakeSchedule({type: 'remote', projectPath: 'ssh://me@box/srv/app'}),
        canMakeSchedule({type: 'claude', projectPath: 'ssh://me@box/srv/app'}),
        canMakeSchedule({type: 'claude', projectPath: ''}),
    ];

    /* Then */
    assert.deepEqual(can, [false, false, false, false]);
});
