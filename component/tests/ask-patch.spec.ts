/**
 * Asking Patch to start a session from the empty screen (#135).
 *
 * Main is played by `fakeRoute` below: it answers `askRoute` with what main's
 * own reading of the CLI's output (`readAskPatchRun`, src/domain/ask/route.ts)
 * makes of the answer set, after its delay, and answers `cancelled` once
 * `cancelAskRoute` comes in, as main does. A session starting is the
 * `openTerminal` call it makes: its directory and its first prompt.
 *
 * The journey through the real `claude -p` (warmed on focus, the request on
 * its stdin, the session it starts) stays in e2e/tests/ask-patch.spec.ts. The
 * routing rules and the box's state are unit tested (test/ask-route*.test.ts,
 * test/ask-slice.test.ts, test/ask-keys.test.ts).
 */
import {test, expect} from '../support/test';
import {dialog} from '../../e2e/support/app';
import {P} from '../../e2e/fixtures/standard';
import {HARNESS_SETTINGS} from '../../e2e/support/fixture-home';
import {fixtureProjectPath} from '../fixtures/captured';
import {runSessions} from '../support/running-session';
import {readAskPatchRun} from '../../src/domain/ask/route';
import type {Page} from '@playwright/test';
import type {FakeApi} from '../support/fake-api';
import type {AskPatchResult, RouteRequest} from '../../src/domain/ask/model';
import type {ClaudeRun} from '../../src/domain/ask/route';
import type {RouteAnswer} from '../../e2e/support/fake-cli';

const box = (page: Page) => page.getByTestId('ask-box');
const says = (page: Page, line: string | RegExp) => page.locator('#placeholder').getByText(line);

interface FakeRoute {
    /** What the next calls answer, as Haiku's JSON; held back `delayMs`. */
    answer(answer: RouteAnswer, delayMs?: number): void;
    /** Fail the way the CLI does: the envelope with `is_error`, and exit 1. */
    fail(message: string): void;
    /** Every request main was asked to route, oldest first. */
    requests(): RouteRequest[];
}

/** Answer the box's routing calls as main does with the CLI answering `answer`. */
function fakeRoute(api: FakeApi): FakeRoute {
    let run: ClaudeRun & {delayMs: number} = {exitCode: 0, stdout: '', stderr: '', delayMs: 0};
    let cancel: (() => void) | null = null;
    const envelope = (result: string, isError: boolean): string =>
        JSON.stringify({type: 'result', subtype: 'success', is_error: isError, result}) + '\n';

    api.handle('askRoute', (request) => {
        const answered = run;
        return new Promise<AskPatchResult>((resolve) => {
            const timer = setTimeout(() => {
                cancel = null;
                resolve(readAskPatchRun(answered, request));
            }, answered.delayMs);
            cancel = () => {
                clearTimeout(timer);
                resolve({kind: 'cancelled'});
            };
        });
    });
    api.handle('cancelAskRoute', () => {
        cancel?.();
        cancel = null;
    });
    return {
        answer: (answer, delayMs = 0) => {
            run = {exitCode: 0, stdout: envelope(JSON.stringify(answer), false), stderr: '', delayMs};
        },
        fail: (message) => {
            run = {exitCode: 1, stdout: envelope(message, true), stderr: '', delayMs: 0};
        },
        requests: () => api.callsTo('askRoute').map(([request]) => request),
    };
}

/** The sessions started, as the directory and first prompt each was opened with. */
function launches(api: FakeApi): {cwd: string; prompt: string | undefined}[] {
    return api
        .callsTo('openTerminal')
        .filter(([, , isNew]) => isNew)
        .map(([, cwd, , options]) => ({cwd, prompt: options?.initialPrompt}));
}

test.beforeEach(({api}) => {
    runSessions(api);
});

test('an unsure answer offers the candidates, and Enter starts the one picked', async ({page, api}) => {
    /* Given */
    const route = fakeRoute(api);
    const acmeApi = fixtureProjectPath(P.acmeApi);
    const dashboard = fixtureProjectPath(P.webDashboard);
    route.answer(
        {projectPath: acmeApi, confident: false, candidates: [acmeApi, dashboard], prompt: 'Make the charts faster.'},
        500,
    );

    /* When */
    await box(page).fill('make the charts faster');
    await box(page).press('Enter');

    /* Then */
    await expect(box(page)).toHaveAttribute('aria-busy', 'true');
    await expect(says(page, /think|Thinking|again…/)).toBeVisible();
    const choices = page.getByRole('listbox', {name: 'Projects'});
    await expect(choices.getByRole('option')).toHaveCount(2);
    await expect(choices.getByRole('option', {selected: true})).toContainText('acme-api');
    await expect(page.getByTestId('ask-choices')).toContainText('Make the charts faster.');

    /* When */
    await box(page).press('ArrowDown');
    await box(page).press('Enter');

    /* Then */
    await expect.poll(() => launches(api)).toEqual([{cwd: dashboard, prompt: 'Make the charts faster.'}]);
});

test('Esc while Patch is thinking cancels, and the text can be edited again', async ({page, api}) => {
    /* Given */
    const route = fakeRoute(api);
    const acmeApi = fixtureProjectPath(P.acmeApi);
    // The answer comes after the cancel; it must not start anything when it lands.
    route.answer({projectPath: acmeApi, confident: true, candidates: [acmeApi], prompt: 'Too late.'}, 500);

    /* When */
    await box(page).fill('fix the login loop');
    await box(page).press('Enter');
    await expect(box(page)).toHaveAttribute('aria-busy', 'true');
    await box(page).press('Escape');

    /* Then */
    await expect(says(page, 'Okay, never mind.')).toBeVisible();
    await expect(box(page)).toHaveValue('fix the login loop');
    await expect(box(page)).toBeEditable();
    expect(api.callsTo('cancelAskRoute')).toHaveLength(1);
    await page.waitForTimeout(800);
    expect(launches(api)).toEqual([]);
});

test('a failed call says why and opens the picker, which starts on the text as typed', async ({page, api}) => {
    /* Given */
    const route = fakeRoute(api);
    route.fail('You’ve hit your limit · resets 3pm (UTC)');

    /* When */
    await box(page).fill('fix the login loop');
    await box(page).press('Enter');

    /* Then */
    await expect(says(page, 'You’ve hit your usage limit — resets 3pm (UTC).')).toBeVisible();
    const picker = dialog(page, 'Start this in…');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('fix the login loop');

    /* When */
    await picker.getByText(P.acmeApi, {exact: true}).click();

    /* Then */
    await expect
        .poll(() => launches(api))
        .toEqual([{cwd: fixtureProjectPath(P.acmeApi), prompt: 'fix the login loop'}]);
});

test('⌘Enter without a quick folder opens the picker on the text as typed, with no routing call, and Patch says why', async ({
    page,
    api,
}) => {
    /* Given */
    const route = fakeRoute(api);
    route.answer({projectPath: null, confident: false, candidates: [], prompt: ''});

    /* When */
    await box(page).fill('jot down an idea');
    await box(page).press('Meta+Enter');

    /* Then */
    const picker = dialog(page, 'Start this in…');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('jot down an idea');
    await expect(
        says(page, 'There’s no Quick Session Folder yet. Pick a project, or set one in Settings?'),
    ).toBeVisible();
    expect(route.requests().filter((request) => request.text.includes('jot down an idea'))).toEqual([]);
});

test.describe('with a quick folder', () => {
    test.use({settings: {global: {...HARNESS_SETTINGS, quickSessionPath: '/tmp'}}});

    test('⌘Enter starts a quick session on the text as typed, with no routing call', async ({page, api}) => {
        /* Given */
        const route = fakeRoute(api);
        const acmeApi = fixtureProjectPath(P.acmeApi);
        route.answer({
            projectPath: acmeApi,
            confident: true,
            candidates: [acmeApi],
            prompt: 'Fix the login redirect loop.',
        });

        /* When */
        await box(page).fill('lets fix the login loop in acme-api');
        await box(page).press('Meta+Enter');

        /* Then */
        await expect.poll(() => launches(api)).toEqual([{cwd: '/tmp', prompt: 'lets fix the login loop in acme-api'}]);
        expect(route.requests().filter((request) => request.text.includes('lets fix the login loop'))).toEqual([]);
        await expect(dialog(page, 'Start this in…')).toBeHidden();
    });
});

test('a simple question is answered under the box, and ⌘Enter still takes it towards a session', async ({
    page,
    api,
}) => {
    /* Given */
    const route = fakeRoute(api);
    route.answer({
        answer: 'Run lsof -iTCP -sTCP:LISTEN -n -P.',
        projectPath: null,
        confident: false,
        candidates: [],
        prompt: '',
    });
    const question = 'how do I list listening ports on macOS?';

    /* When */
    await box(page).fill(question);
    await box(page).press('Enter');

    /* Then */
    await expect(page.getByTestId('ask-answer')).toContainText('Run lsof -iTCP -sTCP:LISTEN -n -P.');
    await expect(says(page, 'Easy one! Here you go.')).toBeVisible();
    await expect(box(page)).toHaveValue(question);
    await expect(box(page)).toBeFocused();
    await expect(dialog(page, 'Start this in…')).toBeHidden();
    expect(launches(api)).toEqual([]);
    expect(route.requests().at(-1)?.text).toBe(question);

    /* When */
    await box(page).press('Escape');

    /* Then */
    await expect(page.getByTestId('ask-answer')).toBeHidden();
    await expect(box(page)).toHaveValue(question);

    /* When */
    await box(page).press('Meta+Enter');

    /* Then */
    const picker = dialog(page, 'Start this in…');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText(question);
});
