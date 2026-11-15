/**
 * The Session work page (#74): opening it from a row's meta line and with
 * Cmd+G, every way of closing it, the keys it takes, what it hands to main,
 * and the diff.
 *
 * What the page shows for a given snapshot (groups, pills, labels, cards,
 * buttons) is decided by the session-work slice and `describe`, unit tested in
 * test/session-work-*.test.ts; these tests only prove the wiring.
 *
 * The page's back end answers from the e2e stub (e2e/fixtures/session-work.ts):
 * the login-fix and dashboard sessions can open, with a snapshot each. A
 * session outside a git repository, against the real service, is in
 * e2e/tests/session-work.spec.ts.
 */
import {test, expect} from '../support/test';
import {openSession, runSessions} from '../support/running-session';
import {openLoginFixWork, sessionWorkAnswers, terminalInput, workHeading, workPage} from '../support/session-work';
import {sessionRow, sidebar, terminalHeader} from '../../e2e/support/app';
import {hasTerminal} from '../../e2e/support/terminal';
import {sessionItem} from '../../e2e/support/session-list';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {BIG_FILE_LINES, sessionWorkStub} from '../../e2e/fixtures/session-work';
import type {Page} from '@playwright/test';
import type {FakeApi} from '../support/fake-api';

test.use({answers: sessionWorkAnswers(sessionWorkStub())});

/** The meta line of a row, as the button that opens its page. */
function workTrigger(page: Page, label: string) {
    return sidebar(page).getByRole('button', {name: 'Open session work for ' + label, exact: true});
}

/** How often the login-fix session was started. */
function launches(api: FakeApi): number {
    return api.callsTo('openTerminal').filter(([id]) => id === S.loginFix).length;
}

/** The page is gone, the terminal is back with the focus, and its process never restarted. */
async function expectBackOnTerminal(page: Page, api: FakeApi): Promise<void> {
    await expect(workPage(page)).toHaveCount(0);
    await expect(terminalHeader(page)).toBeVisible();
    await expect(terminalInput(page)).toBeFocused();
    expect(launches(api)).toBe(1);
    expect(await hasTerminal(page, S.loginFix)).toBe(true);
}

/** Open the page again with Cmd+G, from the terminal it closed back to. */
async function reopen(page: Page): Promise<void> {
    await page.keyboard.press('Meta+g');
    await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
}

function closes(api: FakeApi): string[] {
    return api.callsTo('closeSessionWork').map(([id]) => id);
}

test.describe('with a repository', () => {
    test('the meta line opens the page, and puts its session on screen first', async ({page, api}) => {
        /* Given */
        runSessions(api);
        const trigger = workTrigger(page, LABEL.loginFix);
        await expect(trigger).toHaveAttribute('title', 'Open session work · ⌘G');

        /* When */
        await trigger.click();

        /* Then */
        await expect.poll(() => launches(api)).toBe(1);
        await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
        await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
        // The page has the terminal's place; the terminal is still there underneath.
        await expect(terminalHeader(page)).toBeHidden();
        expect(await hasTerminal(page, S.loginFix)).toBe(true);
    });

    test('Cmd+G opens the page for the session on screen; Cmd+G, Esc, Back, its row and another session close it', async ({
        page,
        api,
    }) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await expect(terminalInput(page)).toBeFocused();

        /* When */
        await page.keyboard.press('Meta+g');

        /* Then */
        await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
        await expect(workPage(page)).toBeFocused();

        /* When */
        await page.keyboard.press('Meta+g');

        /* Then */
        await expectBackOnTerminal(page, api);
        await expect.poll(() => closes(api)).toHaveLength(1);

        /* When */
        await reopen(page);
        await page.keyboard.press('Escape');

        /* Then */
        await expectBackOnTerminal(page, api);
        await expect.poll(() => closes(api)).toHaveLength(2);

        /* When */
        await reopen(page);
        await workPage(page).getByRole('button', {name: 'Back to terminal (Esc)'}).click();

        /* Then */
        await expectBackOnTerminal(page, api);
        await expect.poll(() => closes(api)).toHaveLength(3);

        /* When */
        await reopen(page);
        await sessionRow(page, LABEL.loginFix).click();

        /* Then */
        await expectBackOnTerminal(page, api);
        await expect.poll(() => closes(api)).toHaveLength(4);

        /* When */
        await reopen(page);
        await openSession(page, api, LABEL.chartsDarkMode, S.chartsDarkMode);

        /* Then */
        await expect(workPage(page)).toHaveCount(0);
        await expect(terminalHeader(page)).toContainText(LABEL.chartsDarkMode);
        await expect.poll(() => closes(api)).toEqual(Array(5).fill(S.loginFix));
    });

    test('the page shows its snapshot, links out, takes j and k, and names the working agents', async ({page, api}) => {
        /* Given */
        await openLoginFixWork(page, api);
        const work = workPage(page);
        const list = work.getByRole('navigation', {name: 'Work items'});
        const detail = work.getByRole('region', {name: 'Selected work item'});
        const openedExternally = () => api.callsTo('openExternal').map(([url]) => url);

        /* Then */
        await expect(work.getByRole('link', {name: 'acme/api', exact: true})).toBeVisible();
        await expect(work.getByText('2 worktrees · 3 branches', {exact: true})).toBeVisible();
        await expect(list.getByText('In progress', {exact: true})).toBeVisible();
        await expect(list.getByText('Issues', {exact: true})).toBeVisible();
        const first = list.getByRole('button', {name: /Stop the login redirect loop/});
        await expect(first).toContainText('#1320');
        await expect(first).toHaveAttribute('aria-current', 'true');
        await expect(detail.getByRole('heading', {level: 2})).toHaveText('Stop the login redirect loop #1320');
        await expect(page.getByTestId('session-work-agents')).toHaveCount(0);

        /* When */
        await detail.getByRole('link', {name: '#1301'}).click();

        /* Then */
        await expect.poll(openedExternally).toContain('https://github.com/acme/api/issues/1301');

        /* When */
        // An issue is a link out, not a selection.
        await list.getByRole('link', {name: /Users get logged out on refresh/}).click();

        /* Then */
        await expect.poll(openedExternally).toContain('https://github.com/acme/api/issues/1290');

        /* When */
        await work.focus();
        await page.keyboard.press('j');

        /* Then */
        const second = list.getByRole('button', {name: /Add a regression test/});
        await expect(second).toHaveAttribute('aria-current', 'true');
        await expect(second).toBeFocused();
        await expect(detail.getByRole('heading', {level: 2})).toContainText('Add a regression test');

        /* When */
        await page.keyboard.press('k');

        /* Then */
        await expect(first).toHaveAttribute('aria-current', 'true');

        /* When */
        await api.emit('onSessionAgents', S.loginFix, [
            {id: 'a1', title: 'Audit the cookie flags'},
            {id: 'a2', title: 'Write the redirect test'},
        ]);

        /* Then */
        const strip = page.getByTestId('session-work-agents');
        await expect(strip).toContainText('2 agents working');
        await expect(strip).toContainText('Audit the cookie flags');
        await expect(strip).toContainText('Write the redirect test');
    });
});

test.describe('actions', () => {
    function actions(page: Page) {
        return workPage(page).getByRole('group', {name: 'Actions'});
    }

    async function select(page: Page, name: RegExp): Promise<void> {
        await workPage(page).getByRole('navigation', {name: 'Work items'}).getByRole('button', {name}).click();
    }

    test('a PR offers only Open on GitHub, and a branch offers nothing', async ({page, api}) => {
        /* Given */
        await openLoginFixWork(page, api);

        /* When */
        await actions(page).getByRole('button', {name: 'Open on GitHub'}).click();

        /* Then */
        await expect(actions(page).getByRole('button')).toHaveCount(1);
        await expect
            .poll(() => api.callsTo('openExternal').map(([url]) => url))
            .toContain('https://github.com/acme/api/pull/1320');

        /* When */
        await select(page, /spike\/cookie-store/);

        /* Then */
        await expect(actions(page)).toHaveCount(0);
    });
});

test.describe('the diff', () => {
    function diffOf(page: Page) {
        return workPage(page).getByTestId('session-work-diff');
    }

    function fileCard(page: Page, path: string) {
        return diffOf(page).getByRole('region', {name: path, exact: true});
    }

    test('loads for the selected item; u, the toggle, n and p work it; a 1,500-line file fills in without holding up the keyboard', async ({
        page,
        api,
    }) => {
        /* Given */
        await openLoginFixWork(page, api);
        const diff = diffOf(page);
        const session = fileCard(page, 'src/session.ts');
        const cards = diff.getByTestId('session-work-file');

        /* Then */
        await expect(diff).toHaveAttribute('aria-busy', 'false');
        await expect(cards).toHaveCount(4);
        await expect(diff.getByText('4 files changed', {exact: true})).toBeVisible();
        await expect(diff.getByRole('button', {name: 'Unified'})).toHaveAttribute('aria-pressed', 'true');
        await expect(session.locator('.sw-dl[data-kind="delete"]')).toHaveCount(2);
        await expect(session.locator('.sw-dl[data-kind="add"]')).toHaveCount(3);

        /* When */
        await page.keyboard.press('u');

        /* Then */
        await expect(diff.getByRole('button', {name: 'Split'})).toHaveAttribute('aria-pressed', 'true');
        await expect(session.locator('.sw-lines')).toHaveClass(/\bis-split\b/);

        /* When */
        await diff.getByRole('button', {name: 'Unified'}).click();

        /* Then */
        await expect(session.locator('.sw-lines')).toHaveClass(/\bis-unified\b/);

        /* When */
        await workPage(page).focus();
        await page.keyboard.press('n');

        /* Then */
        await expect(cards.nth(0)).toHaveClass(/\bis-focused\b/);
        await expect(cards.nth(0).locator('.sw-file-head')).toBeFocused();

        /* When */
        await page.keyboard.press('n');
        await page.keyboard.press('n');
        await page.keyboard.press('p');

        /* Then */
        await expect(cards.nth(1)).toHaveClass(/\bis-focused\b/);
        await expect(cards.nth(0)).not.toHaveClass(/\bis-focused\b/);
        await expect(cards.nth(1).locator('.sw-file-head')).toBeFocused();
        const big = fileCard(page, 'src/fixtures/big.ts');
        await expect(big).toContainText(`Large diff · ${BIG_FILE_LINES.toLocaleString('en-US')} lines changed`);
        await expect(big.locator('.sw-dl')).toHaveCount(0);

        /* When */
        await big.getByRole('button', {name: 'Show diff'}).click();
        // The page still answers while the file fills in.
        await page.keyboard.press('u');

        /* Then */
        await expect(diff.getByRole('button', {name: 'Split'})).toHaveAttribute('aria-pressed', 'true');
        await expect(big.locator('.sw-lines')).toHaveAttribute('data-shown', String(BIG_FILE_LINES + 1));
        await expect(big.locator('.sw-dl.is-pair')).toHaveCount(BIG_FILE_LINES);
        await expect(big.locator('.sw-dl.is-pair').last()).toContainText(
            `export const line${BIG_FILE_LINES} = ${BIG_FILE_LINES};`,
        );
    });
});
