/**
 * The Schedule manager's page: ⌘J opens the overview on the facts main
 * pushes (the header's line, the night, Needs you as a card with its pill,
 * Scheduled as rows), J and ⏎ open a schedule's page on what main reads for
 * it (its runs with the prompt's changes between them, its prompt), Save as
 * v4 hands main the edited prompt and its note, and Esc goes back to the
 * overview and then to the session it covered.
 *
 * The groups, the night strip, the times, the markers and the keys are unit
 * tested (test/schedule-*.test.ts); this proves the page and its keys
 * against what main answers.
 */
import {test, expect} from '../support/test';
import {openSession} from '../support/running-session';
import {terminalHeader} from '../../e2e/support/app';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {LABEL, S} from '../../e2e/fixtures/standard';
import type {
    ScheduleDetail,
    ScheduleManagerFacts,
    ScheduleRun,
    ScheduleSettings,
    ScheduleSummary,
} from '../../src/domain/schedule/manager';
import type {Page} from '@playwright/test';

const HOUR = 3_600_000;
/** Wednesday 10 June, 03:00 UTC: last night. */
const LAST_NIGHT = FIXTURE_NOW - 11 * HOUR;
const SWEEP = '/fixture/acme-api/.claude/commands/schedule-bugsnag-sweep.md';
const NOTES = '/fixture/acme-web/.claude/commands/schedule-release-notes.md';

function settings(name: string, slug: string, projectPath: string, cron: string): ScheduleSettings {
    return {
        name,
        slug,
        projectPath,
        cron,
        enabled: true,
        prompt: 'Fix the worst Bugsnag errors, one PR each.',
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        allowedTools: 'Bash,Read,Edit',
        limitMinutes: 20,
        weekCap: 80,
        missed: 'run-once',
        worktree: true,
    };
}

function run(id: string, key: string, fields: Partial<ScheduleRun>): ScheduleRun {
    return {
        id,
        scheduleKey: key,
        sessionId: `session-${id}`,
        trigger: 'cron',
        dueAt: LAST_NIGHT,
        startedAt: LAST_NIGHT,
        status: 'done',
        reason: null,
        promptVersion: 3,
        report: 'Nothing new.',
        weekBefore: 40,
        weekAfter: 41,
        worktree: null,
        seen: true,
        ...fields,
        endedAt: fields.endedAt ?? (fields.startedAt ?? LAST_NIGHT) + 12 * 60_000,
    };
}

const LIMITED = run('r3', SWEEP, {
    status: 'limit',
    reason: 'its 20 min limit',
    endedAt: LAST_NIGHT + 23 * 60_000,
    report: 'Stopped at its 20-minute limit while fixing the 3rd of 5 errors.',
    seen: false,
});

const SWEEP_SUMMARY: ScheduleSummary = {
    key: SWEEP,
    settings: settings('Bugsnag sweep', 'bugsnag-sweep', '/fixture/acme-api', '0 3 * * *'),
    runsOn: {kind: 'mac'},
    group: 'needsYou',
    nextRunAt: LAST_NIGHT + 24 * HOUR,
    lastRuns: ['done', 'failed', 'limit'],
    last: LIMITED,
    typicalMinutes: 14,
    typicalWeekShare: 2,
    promptVersion: 3,
};

const NOTES_SUMMARY: ScheduleSummary = {
    key: NOTES,
    settings: settings('Release notes', 'release-notes', '/fixture/acme-web', '0 4 * * *'),
    runsOn: {kind: 'mac'},
    group: 'scheduled',
    nextRunAt: LAST_NIGHT + 25 * HOUR,
    lastRuns: ['done', 'done'],
    last: run('n1', NOTES, {
        startedAt: LAST_NIGHT + HOUR,
        endedAt: LAST_NIGHT + HOUR + 4 * 60_000,
        report: 'Draft updated',
    }),
    typicalMinutes: 4,
    typicalWeekShare: 0.5,
    promptVersion: 1,
};

const FACTS: ScheduleManagerFacts = {
    schedules: [NOTES_SUMMARY, SWEEP_SUMMARY],
    recentRuns: [LIMITED, NOTES_SUMMARY.last!],
    wakeAt: null,
    suggestedWakeAt: '02:55',
    week: 44,
};

const DETAIL: ScheduleDetail = {
    summary: SWEEP_SUMMARY,
    runs: [
        LIMITED,
        run('r2', SWEEP, {startedAt: LAST_NIGHT - 24 * HOUR, report: 'Fixed 1 error.', promptVersion: 3}),
        run('r1', SWEEP, {
            startedAt: LAST_NIGHT - 48 * HOUR,
            status: 'failed',
            report: 'Spent the run on handled warnings.',
            promptVersion: 2,
        }),
    ],
    versions: [
        {
            version: 3,
            text: 'Fix the worst Bugsnag errors, one PR each.',
            savedAt: LAST_NIGHT - 30 * HOUR,
            note: 'skip warnings with no users',
        },
        {version: 2, text: 'Fix every Bugsnag error.', savedAt: LAST_NIGHT - 10 * 24 * HOUR, note: null},
    ],
    stats: {
        total: 3,
        done: 1,
        failed: 2,
        caughtUp: 0,
        since: LAST_NIGHT - 48 * HOUR,
        medianMinutes: 12,
        medianWeekShare: 2,
        thisWeekShare: 5,
    },
};

function schedulePage(page: Page) {
    return page.getByRole('region', {name: 'Schedule manager'});
}

test.use({answers: {scheduleManagerFacts: FACTS, scheduleManagerDetail: DETAIL}});

test("⌘J opens the overview, ⏎ a schedule's page with its runs and prompt, and Esc goes back step by step", async ({
    page,
    api,
}) => {
    /* Given */
    await api.emit('onScheduleManagerChanged', FACTS);
    await openSession(page, api, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+KeyJ');

    /* Then: the header's line, the wake to set, the night, Needs you first */
    const manager = schedulePage(page);
    await expect(manager.getByRole('heading', {name: 'Schedule manager'})).toBeVisible();
    await expect(manager).toContainText(
        '2 schedules in 2 projects · 2 run tonight · Mac not set to wake · week at 44%',
    );
    await expect(manager.getByRole('button', {name: 'Wake the Mac at 02:55'})).toBeVisible();
    await expect(manager.getByRole('region', {name: 'The night'})).toContainText('Last night: 1 done · 1 failed');
    const needsYou = manager.getByRole('group', {name: 'Needs you'});
    await expect(needsYou).toContainText('Bugsnag sweep');
    await expect(needsYou).toContainText('TIME LIMIT');
    await expect(needsYou).toContainText('Every night at 03:00');
    await expect(manager.getByRole('group', {name: 'Scheduled'})).toContainText('Release notes');

    /* When */
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');

    /* Then: the schedule's page, its runs newest first with the prompt's change between them */
    await expect(manager.getByRole('heading', {name: 'Bugsnag sweep'})).toBeVisible();
    expect(api.callsTo('scheduleManagerDetail')).toContainEqual([SWEEP]);
    const runs = manager.getByRole('listbox', {name: 'Runs'});
    await expect(runs.getByRole('option')).toHaveCount(3);
    await expect(runs.getByRole('separator')).toContainText('Prompt changed to v3');
    await expect(runs.getByRole('separator')).toContainText('skip warnings with no users');
    await expect(manager.getByLabel('Prompt', {exact: true})).toHaveValue('Fix the worst Bugsnag errors, one PR each.');
    await expect(manager).toContainText('v3 · edited Mon · 2 runs since');

    /* When */
    await page.keyboard.press('Enter');

    /* Then: the newest run unfolds to its report and its actions */
    await expect(runs.getByRole('button', {name: /Carry on in a session/})).toBeVisible();
    await expect(runs.getByRole('button', {name: 'Tune the prompt from this run'})).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(manager.getByRole('heading', {name: 'Schedule manager'})).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(manager).toBeHidden();
    await expect(terminalHeader(page)).toContainText(LABEL.loginFix);
});

test('an edited prompt saves as the next version with its note, and the wake is set to the one suggested', async ({
    page,
    api,
}) => {
    /* Given */
    api.answer('scheduleManagerSave', {key: SWEEP});
    api.answer('scheduleManagerSetWake', {ok: true});
    await api.emit('onScheduleManagerChanged', FACTS);
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+KeyJ');
    const manager = schedulePage(page);

    /* When */
    await manager.getByRole('button', {name: 'Wake the Mac at 02:55'}).click();

    /* Then */
    await expect.poll(() => api.callsTo('scheduleManagerSetWake')).toEqual([['02:55']]);

    /* When */
    await manager.getByRole('button', {name: 'Bugsnag sweep', exact: true}).click();
    await manager.getByLabel('Prompt', {exact: true}).fill('Fix the worst two errors.');
    await manager.getByLabel('What changed (optional)').fill('two at most');
    await manager.getByRole('button', {name: 'Save as v4'}).click();

    /* Then */
    await expect.poll(() => api.callsTo('scheduleManagerSave')).toHaveLength(1);
    const [key, saved, note, runNow] = api.callsTo('scheduleManagerSave')[0]!;
    expect(key).toBe(SWEEP);
    expect(saved).toMatchObject({name: 'Bugsnag sweep', cron: '0 3 * * *', prompt: 'Fix the worst two errors.'});
    expect(note).toBe('two at most');
    expect(runNow).toBe(false);
    await expect(manager.getByRole('status')).toHaveText('Saved.');
});
