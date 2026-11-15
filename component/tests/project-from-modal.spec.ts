/**
 * The Projects modal leads to the project page (#177): → on the highlighted
 * project, or its Open button, closes the modal and opens the project's page
 * with no sidebar row lit (#168); a worktree opens its repository's page; and
 * with a prompt from Quick Ask waiting, → does nothing. A plan now opens from
 * the page, inside it (#173, #174), and the routes #168 asked for still hold:
 * no row lit, ⌘[ back to the overview, Esc back to the session the page
 * covered, lit and focused.
 *
 * Main is answered as the e2e host stubs answered it (component/support/
 * project-page.ts); a session started is the `openTerminal` call the renderer
 * makes. The keys are unit tested in test/projects-modal.test.ts; the main
 * area's route and its highlight in test/main-area-slice.test.ts. Adding a
 * project and landing on its page is walked in e2e/tests/dialogs.spec.ts.
 */
import {test, expect} from '../support/test';
import {fixtureProjectPath} from '../fixtures/captured';
import {openSession, PROJECT_PAGE_ANSWERS, runSessions, stubOverviews, stubPlans} from '../support/project-page';
import {dialog, rowButton, sidebar} from '../../e2e/support/app';
import {sessionItem} from '../../e2e/support/session-list';
import {LABEL, P, S} from '../../e2e/fixtures/standard';
import {acmeOverview, plansStub} from '../../e2e/fixtures/plans';
import type {Locator, Page} from '@playwright/test';

/** A worktree of old-parser, listed as a project of its own. */
const WORKTREE_NAME = 'Development/old-parser ⎇ streaming';

function picker(page: Page) {
    return dialog(page, 'Projects');
}

function filter(page: Page) {
    return picker(page).getByLabel('Filter projects');
}

/** The keys that work, under the list. */
function footer(modal: Locator) {
    return modal.locator('.projects-footer');
}

function projectPage(page: Page) {
    return page.getByRole('region', {name: 'Project ' + P.acmeApi});
}

function plansSection(page: Page) {
    return projectPage(page).getByRole('region', {name: 'Plans & issues'});
}

function planPage(page: Page) {
    return page.getByRole('region', {name: /^Plan in /});
}

function sessionRows(page: Page) {
    return sidebar(page).locator('[data-session-id]');
}

/** The lit rows: the highlight is the row's `active` class. */
function litRows(page: Page) {
    return sidebar(page).locator('[data-session-id].active');
}

function terminalInput(page: Page) {
    return page.getByRole('textbox', {name: 'Terminal input'});
}

/** Take the focus off whatever has it, so ⌘A reaches the app rather than a field. */
async function blur(page: Page) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** ⌘A, then acme-api highlighted. */
async function openPickerOnAcme(page: Page): Promise<void> {
    await blur(page);
    await page.keyboard.press('Meta+a');
    await expect(picker(page).getByText(P.acmeApi, {exact: true})).toBeVisible();
    await filter(page).fill('acme-api');
}

/** acme-api's page through the modal, then its "Login rework" plan inside it. */
async function openLoginRework(page: Page): Promise<void> {
    await openPickerOnAcme(page);
    await page.keyboard.press('ArrowRight');
    await plansSection(page).getByText('Login rework', {exact: true}).click();
    await expect(planPage(page).getByRole('heading', {name: 'Login rework'})).toBeVisible();
}

test.use({answers: PROJECT_PAGE_ANSWERS});

test.beforeEach(({api}) => {
    stubOverviews(api, {[P.acmeApi]: acmeOverview()});
    stubPlans(api, plansStub());
    runSessions(api);
});

test('⌘A, →: the project page opens in the modal’s place, with no row lit and no session started', async ({
    page,
    api,
}) => {
    /* Given */
    const rowsBefore = await sessionRows(page).count();
    await openPickerOnAcme(page);
    await expect(footer(picker(page))).toContainText('→open project');
    await expect(footer(picker(page))).not.toContainText('plans');

    /* When */
    await page.keyboard.press('ArrowRight');

    /* Then */
    await expect(picker(page)).toHaveCount(0);
    await expect(projectPage(page).getByRole('heading', {level: 1})).toHaveText(P.acmeApi);
    await expect(projectPage(page)).toBeFocused();
    await expect(plansSection(page).getByText('Login rework', {exact: true})).toBeVisible();
    await expect(litRows(page)).toHaveCount(0);
    await expect(sessionRows(page)).toHaveCount(rowsBefore);
    expect(api.callsTo('openTerminal')).toEqual([]);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(page.getByTestId('project-page')).toBeHidden();
    await expect(page.getByTestId('empty-screen')).toBeVisible();
});

test('the highlighted row’s Open button opens the page too, and a worktree opens its repository’s', async ({page}) => {
    /* Given */
    await blur(page);
    await page.keyboard.press('Meta+a');
    const worktree = picker(page).getByText(WORKTREE_NAME, {exact: true});
    await worktree.hover();

    /* When */
    await rowButton(worktree, 'Open').click();

    /* Then */
    await expect(picker(page)).toHaveCount(0);
    await expect(
        page.getByRole('region', {name: 'Project Development/old-parser'}).getByRole('heading', {level: 1}),
    ).toHaveText('Development/old-parser');
    await expect(litRows(page)).toHaveCount(0);
});

test('a plan opens inside the page with no row lit; ⌘[ goes back to the overview, and Esc closes the detail, then the page', async ({
    page,
}) => {
    /* Given */
    await openPickerOnAcme(page);
    await page.keyboard.press('ArrowRight');

    /* When */
    await plansSection(page).getByText('Login rework', {exact: true}).click();

    /* Then */
    await expect(planPage(page).getByRole('button', {name: 'Back to Development/acme-api (⌘[)'})).toBeVisible();
    await expect(planPage(page).getByRole('heading', {name: 'Login rework'})).toBeVisible();
    await expect(
        planPage(page)
            .getByTestId('plan-diagram')
            .getByRole('button', {name: /^#1302 /}),
    ).toBeVisible();
    await expect(page.getByTestId('empty-screen')).toBeHidden();
    await expect(litRows(page)).toHaveCount(0);

    /* When */
    await planPage(page)
        .getByTestId('plan-diagram')
        .getByRole('button', {name: /^#1302 /})
        .click();

    /* Then */
    const detail = planPage(page).getByRole('complementary', {name: 'Issue detail'});
    await expect(detail.getByRole('heading', {name: 'Stop the login redirect loop'})).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(detail).toHaveCount(0);
    await expect(planPage(page)).toBeVisible();

    /* When */
    await page.keyboard.press('Meta+BracketLeft');

    /* Then */
    await expect(planPage(page)).toHaveCount(0);
    await expect(projectPage(page)).toBeFocused();
    await expect(litRows(page)).toHaveCount(0);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(page.getByTestId('project-page')).toBeHidden();
    await expect(page.getByTestId('empty-screen')).toBeVisible();
});

test('a plan opened over a session lights no row, and Esc brings the session back, lit and focused', async ({
    page,
    api,
}) => {
    /* Given */
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);

    /* When */
    await openLoginRework(page);

    /* Then */
    await expect(litRows(page)).toHaveCount(0);
    await expect(page.getByTestId('terminal-header')).toBeHidden();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(planPage(page)).toHaveCount(0);
    await expect(page.getByTestId('terminal-header')).toBeVisible();
    await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
    await expect(litRows(page)).toHaveCount(1);
    await expect(terminalInput(page)).toBeFocused();
});

test('clicking a sidebar row while a plan is open shows that session and closes the plan', async ({page, api}) => {
    /* Given */
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    await openLoginRework(page);

    /* When */
    await openSession(page, api, LABEL.chartsDarkMode, S.chartsDarkMode);

    /* Then */
    await expect(planPage(page)).toHaveCount(0);
    await expect(page.getByTestId('project-page')).toBeHidden();
    await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bactive\b/);
    await expect(litRows(page)).toHaveCount(1);
});

test('with a prompt waiting, → does nothing and shows greyed, and ↵ still starts on the prompt', async ({
    page,
    api,
}) => {
    /* Given: ⌘↵ starts a session instead of asking, so the prompt waits in the picker */
    const ask = page.getByTestId('ask-box');
    await ask.fill('jot down an idea');
    await ask.press('Meta+Enter');
    const waiting = dialog(page, 'Start this in…');
    await expect(waiting).toContainText('jot down an idea');
    await waiting.getByLabel('Filter projects').fill('acme-api');
    await expect(footer(waiting).locator('.is-off')).toHaveText('→open project');
    await expect(rowButton(waiting.getByText(P.acmeApi, {exact: true}), 'Open')).toHaveCount(0);

    /* When */
    await page.keyboard.press('ArrowRight');

    /* Then */
    await page.waitForTimeout(500);
    await expect(waiting).toBeVisible();
    await expect(page.getByTestId('project-page')).toBeHidden();

    /* When */
    await page.keyboard.press('Enter');

    /* Then */
    await expect.poll(() => api.callsTo('openTerminal')).toHaveLength(1);
    const [, cwd, isNew, options] = api.callsTo('openTerminal')[0];
    expect(cwd).toBe(fixtureProjectPath(P.acmeApi));
    expect(isNew).toBe(true);
    expect(options?.initialPrompt).toBe('jot down an idea');
});
