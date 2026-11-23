/**
 * Creating a schedule: the two-step dialog walked through the renderer
 * against main's answers (the drafts and the save).
 *
 * What it decides on its own — the presets and their crons, the slugs, the
 * tools as chips, the steps and the dropped late answers — is unit tested
 * (test/schedule-*.test.ts). These check that the keys and clicks reach it and
 * what it asks main for.
 */
import {test, expect} from '../support/test';
import {dialog, terminalHeader} from '../../e2e/support/app';
import {openSession} from '../support/running-session';
import {LABEL, P, S} from '../../e2e/fixtures/standard';
import {fixtureProjectPath} from '../fixtures/captured';
import {blankScheduleSettings} from '../../src/domain/schedule/form';
import type {ScheduleDraftResult, ScheduleSettings} from '../../src/domain/schedule/manager';
import type {FakeApi} from '../support/fake-api';
import type {Page} from '@playwright/test';

const PROJECT = fixtureProjectPath(P.acmeApi);

const DRAFTED: ScheduleSettings = {
    ...blankScheduleSettings(PROJECT),
    name: 'Login sweep',
    slug: 'login-sweep',
    prompt: 'Check the login flow. End with a short report.',
    model: 'sonnet',
};

const DRAFT: ScheduleDraftResult = {draft: {settings: DRAFTED, whenReason: '"every night"; 03:00 is quiet'}};

/** Make this a schedule, from the tray of the login-fix session. */
async function makeThisASchedule(page: Page, api: FakeApi): Promise<void> {
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    await terminalHeader(page).getByText(LABEL.loginFix, {exact: true}).hover();
    await page.getByRole('region', {name: 'Session tools'}).getByRole('button', {name: 'Make this a schedule'}).click();
}

test('Make this a schedule in the tray drafts from the session, and ⌘⏎ saves what was reviewed', async ({
    page,
    api,
}) => {
    /* Given */
    api.answer('scheduleManagerDraftFromSession', DRAFT);
    api.answer('scheduleManagerSave', {key: `${PROJECT}/.claude/commands/schedule-login-sweep.md`});
    const review = dialog(page, 'Review the draft');

    /* When */
    await makeThisASchedule(page, api);

    /* Then */
    await expect(review.getByLabel('Name')).toHaveValue('Login sweep');
    await expect(review.getByText('"every night"; 03:00 is quiet')).toBeVisible();
    await expect(review.getByRole('button', {name: 'Nightly'})).toHaveAttribute('aria-pressed', 'true');
    expect(api.callsTo('scheduleManagerDraftFromSession')).toEqual([[S.loginFix]]);

    /* When */
    await review.getByLabel('at', {exact: true}).fill('04:30');
    await review.getByLabel('Name').press('Meta+Enter');

    /* Then */
    await expect(review).toHaveCount(0);
    expect(api.callsTo('scheduleManagerSave')).toEqual([[null, {...DRAFTED, cron: '30 4 * * *'}, null, false]]);
});

test('Esc steps back to the sentence, where a failed draft says why and keeps it', async ({page, api}) => {
    /* Given */
    let answer: ScheduleDraftResult = {error: 'Claude did not answer in time'};
    api.answer('scheduleManagerDraftFromSession', DRAFT);
    api.handle('scheduleManagerDraft', () => answer);
    const create = dialog(page, 'New schedule');
    const review = dialog(page, 'Review the draft');
    const sentence = create.getByLabel('What should it do, and when?');
    await makeThisASchedule(page, api);
    await expect(review.getByLabel('Name')).toHaveValue('Login sweep');

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(sentence).toBeFocused();

    /* When */
    await sentence.fill('Every night, sweep the login errors.');
    await sentence.press('Enter');

    /* Then */
    await expect(create.getByRole('alert')).toHaveText('Claude did not answer in time');
    await expect(sentence).toHaveValue('Every night, sweep the login errors.');

    /* When */
    answer = DRAFT;
    await create.getByRole('button', {name: /^Draft it/}).click();

    /* Then */
    await expect(review.getByLabel('Name')).toHaveValue('Login sweep');
    expect(api.callsTo('scheduleManagerDraft')).toEqual([
        ['Every night, sweep the login errors.', PROJECT],
        ['Every night, sweep the login errors.', PROJECT],
    ]);
});
