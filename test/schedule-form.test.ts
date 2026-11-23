/**
 * The rules behind a schedule's form: blank and copied settings, slugs, the
 * allowed tools as chips plus free text, and what stops a save.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    blankScheduleSettings,
    copyScheduleSettings,
    joinAllowedTools,
    scheduleFileHint,
    scheduleSettingsProblem,
    scheduleSlug,
    splitAllowedTools,
    toggleAllowedTool,
    uniqueSlug,
} from '../src/domain/schedule/form';
import type {ScheduleSettings} from '../src/domain/schedule/manager';

const PROJECT = '/Users/me/code/app';

function settings(overrides: Partial<ScheduleSettings> = {}): ScheduleSettings {
    return {
        ...blankScheduleSettings(PROJECT),
        name: 'Bugsnag sweep',
        slug: 'bugsnag-sweep',
        prompt: 'Look at new errors.',
        ...overrides,
    };
}

// ── Starting points ──

test('a blank schedule runs nightly at 03:00 in a fresh worktree, on, with limits', () => {
    /* When */
    const blank = blankScheduleSettings(PROJECT);

    /* Then */
    assert.equal(blank.projectPath, PROJECT);
    assert.equal(blank.cron, '0 3 * * *');
    assert.equal(blank.enabled, true);
    assert.equal(blank.worktree, true);
    assert.equal(blank.permissionMode, 'acceptEdits');
    assert.equal(blank.missed, 'run-once');
    assert.deepEqual([blank.limitMinutes, blank.weekCap], [30, 80]);
});

test('a copy keeps the settings under a new name and a slug its project does not have', () => {
    /* Given */
    const source = settings({enabled: false, cron: '0 6 * * 1'});

    /* When */
    const copy = copyScheduleSettings(source, new Set(['bugsnag-sweep', 'bugsnag-sweep-copy']));

    /* Then */
    assert.equal(copy.name, 'Bugsnag sweep copy');
    assert.equal(copy.slug, 'bugsnag-sweep-copy-2');
    assert.equal(copy.cron, '0 6 * * 1');
    assert.equal(copy.prompt, source.prompt);
    assert.equal(copy.enabled, true);
});

// ── Slugs ──

test('a name becomes a lower-case dashed slug', () => {
    /* When */
    const slugs = [scheduleSlug('Bugsnag sweep'), scheduleSlug('  Release notes: v2!  '), scheduleSlug('Crème brûlée')];

    /* Then */
    assert.deepEqual(slugs, ['bugsnag-sweep', 'release-notes-v2', 'creme-brulee']);
});

test('a name with nothing to slug falls back to "schedule"', () => {
    /* When */
    const slug = scheduleSlug('!!!');

    /* Then */
    assert.equal(slug, 'schedule');
});

test('a long name is cut to 48 characters without a trailing dash', () => {
    /* When */
    const slug = scheduleSlug('a'.repeat(47) + ' bcd');

    /* Then */
    assert.equal(slug, 'a'.repeat(47));
});

test('a taken slug gets the first free number', () => {
    /* When */
    const slug = uniqueSlug('nightly', new Set(['nightly', 'nightly-2']));

    /* Then */
    assert.equal(slug, 'nightly-3');
});

test('the file hint names the schedule file in the commands folder', () => {
    /* When */
    const hint = scheduleFileHint('bugsnag-sweep');

    /* Then */
    assert.equal(hint, '.claude/commands/schedule-bugsnag-sweep.md');
});

// ── Allowed tools ──

test('known tools become chips in their own order, everything else free text', () => {
    /* When */
    const split = splitAllowedTools('Grep, Bash(git log:*), Read,mcp__bugsnag__list_errors,Bash');

    /* Then */
    assert.deepEqual(split, {tools: ['Bash', 'Read', 'Grep'], extra: 'Bash(git log:*), mcp__bugsnag__list_errors'});
});

test('a comma inside a rule’s parentheses stays in that rule', () => {
    /* When */
    const split = splitAllowedTools('Read,Bash(npm run a,b)');

    /* Then */
    assert.deepEqual(split, {tools: ['Read'], extra: 'Bash(npm run a,b)'});
});

test('chips and free text join back in chip order without spaces, dropping duplicates', () => {
    /* When */
    const allowed = joinAllowedTools(['Grep', 'Bash'], 'mcp__x__y, Grep , ');

    /* Then */
    assert.equal(allowed, 'Bash,Grep,mcp__x__y');
});

test('toggling a chip turns that tool on or off and keeps the free text', () => {
    /* Given */
    const allowed = 'Read,Glob,mcp__x__y';

    /* When */
    const on = toggleAllowedTool(allowed, 'Bash');
    const off = toggleAllowedTool(allowed, 'Glob');

    /* Then */
    assert.equal(on, 'Bash,Read,Glob,mcp__x__y');
    assert.equal(off, 'Read,mcp__x__y');
});

// ── Saving ──

test('complete settings can be saved', () => {
    /* When */
    const problem = scheduleSettingsProblem(settings());

    /* Then */
    assert.equal(problem, null);
});

test('a missing name, project or prompt each stop a save', () => {
    /* When */
    const problems = [
        scheduleSettingsProblem(settings({name: '  '})),
        scheduleSettingsProblem(settings({projectPath: ''})),
        scheduleSettingsProblem(settings({prompt: '\n'})),
    ];

    /* Then */
    assert.deepEqual(problems, ['Give it a name', 'Pick a project', 'Say what it should do in the prompt']);
});

test('a broken cron stops a save with the cron’s own problem', () => {
    /* When */
    const problem = scheduleSettingsProblem(settings({cron: '0 3 * *'}));

    /* Then */
    assert.equal(problem, 'Five fields: minute, hour, day of the month, month, weekday');
});

test('limits must be a positive whole number of minutes and a percentage up to 100', () => {
    /* When */
    const problems = [
        scheduleSettingsProblem(settings({limitMinutes: 0})),
        scheduleSettingsProblem(settings({limitMinutes: 2.5})),
        scheduleSettingsProblem(settings({weekCap: 120})),
        scheduleSettingsProblem(settings({limitMinutes: null, weekCap: null})),
    ];

    /* Then */
    assert.deepEqual(problems, [
        'The time limit is a whole number of minutes',
        'The time limit is a whole number of minutes',
        'The week cap is a percentage from 1 to 100',
        null,
    ]);
});
