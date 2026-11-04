/**
 * The project page (#173) in the real app: a project's name opens it, with no
 * sidebar row lit, and Esc brings the session it covered back, focused and
 * lit; ⌘-click on the name opens GitHub instead; and a session in its
 * Sessions section opens that session in its place. With a stubbed overview
 * (#174), a plan expands to its issues with the keys, ↵ opens it inside the
 * page and coming back finds it expanded, and / filters the rows. The pull
 * requests show with their plan chip, which expands that plan, Show merged
 * adds the merged one, and ↵ opens one on GitHub; with `gh` signed out one
 * message stands in for the GitHub sections (#175). A project opened again
 * shows the answer stored from its last visit while main is asked. In a repo
 * with a merge queue (#315), its section shows over Pull requests, its rows
 * join the cursor, Retry and + Queue reach main, and Nudge asks first with
 * the exact message.
 *
 * The page's own state (expanded plans, Show closed, cursor, filter, what is
 * remembered per project) and the Sessions section's choice are unit tested
 * in test/project-page-slice.test.ts, its rows and keys in
 * test/project-page-plans.test.ts; the pull requests, worktrees and edge
 * states in test/project-page-prs-worktrees.test.ts; the route in
 * test/main-area-slice.test.ts.
 */
import {test, expect, forEachAppearance} from '../support/test';
import {expectScreen, openSession, rowButton, sessionRow, sidebar, terminalHeader} from '../support/app';
import {answerDialogs, dialogsAsked} from '../support/native-dialogs';
import {clipboardWrites, mergeQueueRequests, openedExternally, setHostStub} from '../support/main-process';
import {sessionItem} from '../support/session-list';
import {LABEL, P, S} from '../fixtures/standard';
import {acmeOverview, plansStub} from '../fixtures/plans';
import {acmeQueueOverview, mergeQueueStub} from '../fixtures/merge-queue';
import {nudgeMessage} from '../../src/domain/project/queue-errands';
import type {Page} from '@playwright/test';

function projectPage(page: Page) {
    return page.getByRole('region', {name: 'Project ' + P.acmeApi});
}

/** The lit rows: the highlight is the row's `active` class. */
function litRows(page: Page) {
    return sidebar(page).locator('[data-session-id].active');
}

function terminalInput(page: Page) {
    return page.getByRole('textbox', {name: 'Terminal input'});
}

/** A row's project label: the way into the project's page. */
function rowProjectLink(page: Page, sessionId: string) {
    return sessionItem(page, sessionId).getByTestId('project-link');
}

test('clicking a session’s project label opens the project page with no row lit, and Esc brings the terminal back, focused and lit', async ({
    page,
    home,
}) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);

    /* When */
    await rowProjectLink(page, S.loginFix).click();

    /* Then */
    await expect(projectPage(page).getByRole('heading', {level: 1})).toHaveText(P.acmeApi);
    await expect(projectPage(page)).toBeFocused();
    await expect(litRows(page)).toHaveCount(0);
    await expect(terminalHeader(page)).toBeHidden();
    const sessions = projectPage(page).getByRole('region', {name: 'Sessions'});
    await expect(sessions.getByRole('button', {name: new RegExp(LABEL.loginFix)})).toBeVisible();
    await expect(sessions.getByRole('button', {name: new RegExp(LABEL.worktreeTry)})).toBeVisible();
    await expect(sessions.getByRole('button', {name: new RegExp(LABEL.chartsDarkMode)})).toHaveCount(0);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(projectPage(page)).toHaveCount(0);
    await expect(page.getByTestId('project-page')).toBeHidden();
    await expect(terminalHeader(page)).toBeVisible();
    await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
    await expect(litRows(page)).toHaveCount(1);
    await expect(terminalInput(page)).toBeFocused();
});

test('⌘-click on a project’s name opens its repository on GitHub and leaves the session on screen', async ({
    page,
    app,
    home,
}) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await rowProjectLink(page, S.loginFix).click({modifiers: ['Meta']});

    /* Then */
    await expect.poll(() => openedExternally(app)).toEqual(['repository:' + home.projectPath(P.acmeApi)]);
    await expect(projectPage(page)).toHaveCount(0);
    await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
});

test('the project name in the terminal header opens the page, and a session in it opens in the page’s place', async ({
    page,
    home,
}) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await terminalHeader(page).getByTestId('project-link').click();

    /* Then */
    await expect(projectPage(page)).toBeVisible();
    await expect(litRows(page)).toHaveCount(0);

    /* When */
    await projectPage(page)
        .getByRole('region', {name: 'Sessions'})
        .getByRole('button', {name: new RegExp(LABEL.worktreeTry)})
        .click();

    /* Then */
    await expect(projectPage(page)).toHaveCount(0);
    await expect(sessionItem(page, S.worktreeTry)).toHaveClass(/\bactive\b/);
    await expect(litRows(page)).toHaveCount(1);
});

test.describe('plans and issues', () => {
    test.use({stubs: {projectOverview: {[P.acmeApi]: acmeOverview()}, plans: plansStub()}});

    function plansSection(page: Page) {
        return projectPage(page).getByRole('region', {name: 'Plans & issues'});
    }

    /** The issue rows under the plans and under "Not in a plan", by their titles, in order. */
    function issueTitles(page: Page) {
        return plansSection(page).locator('.pp-issue .pp-issue-title');
    }

    /** The cursor on the first plan: past the three pull requests, which come first. */
    async function cursorToFirstPlan(page: Page) {
        for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    }

    test('a plan is one row that expands to its issues in level order, with the keys, and ↵ opens it inside the page', async ({
        page,
    }) => {
        /* Given */
        await rowProjectLink(page, S.loginFix).click();
        await expect(plansSection(page).getByText('Login rework', {exact: true})).toBeVisible();
        await expect(projectPage(page).getByText('acme/api ↗')).toBeVisible();
        await expect(issueTitles(page)).toHaveText([
            'Health check times out behind the proxy',
            'Document the rate limits',
            'Retry webhooks with backoff',
        ]);
        await expect(plansSection(page).getByText('Move to Postgres 16')).toHaveCount(0);

        /* When */
        await cursorToFirstPlan(page);
        await page.keyboard.press('ArrowRight');

        /* Then */
        await expect(plansSection(page).getByRole('button', {name: 'Collapse plan Login rework'})).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        await expect(issueTitles(page)).toHaveText([
            'Stop the login redirect loop',
            'Remember me for 30 days',
            'Single sign-on with the identity provider',
            'Cookie store behind a port',
            'Magic links',
            'Health check times out behind the proxy',
            'Document the rate limits',
            'Retry webhooks with backoff',
        ]);
        await expect(
            plansSection(page).locator('.pp-issue').filter({hasText: 'Stop the login redirect loop'}),
        ).toContainText('#1320 open');
        await expect(plansSection(page).locator('.pp-issue').filter({hasText: 'Single sign-on'})).toContainText(
            'waits on #1302, #1303',
        );

        /* When */
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');

        /* Then */
        await expect(issueTitles(page)).toHaveCount(3);

        /* When */
        await plansSection(page).getByRole('button', {name: 'Show closed'}).click();

        /* Then */
        await expect(plansSection(page).getByText('Move to Postgres 16')).toBeVisible();

        /* When */
        await projectPage(page).focus();
        await page.keyboard.press('Enter');

        /* Then */
        await expect(
            page.getByRole('region', {name: /^Plan in /}).getByRole('heading', {name: 'Login rework'}),
        ).toBeVisible();

        /* When */
        await page.keyboard.press('Meta+BracketLeft');

        /* Then: the plan viewed last comes back expanded */
        await expect(plansSection(page).getByRole('button', {name: 'Collapse plan Login rework'})).toBeVisible();
    });

    test('a plan’s page marks it while a Claude session that owns one of its issues runs here, and not once it stops', async ({
        page,
        home,
    }) => {
        /* Given: Fix login flow owns #1302 of Login rework, and its terminal is live */
        const planPage = page.getByRole('region', {name: /^Plan in /});
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await rowProjectLink(page, S.loginFix).click();
        await expect(plansSection(page).getByText('Login rework', {exact: true})).toBeVisible();

        /* When */
        await cursorToFirstPlan(page);
        await page.keyboard.press('Enter');

        /* Then */
        await expect(planPage.getByRole('heading', {name: 'Login rework'})).toBeVisible();
        await expect(planPage.getByTestId('plan-live')).toHaveText('1 running');
        await expect(planPage.getByTestId('plan-live')).toHaveAttribute(
            'title',
            '1 Claude session running on this Mac',
        );

        /* When */
        await answerDialogs(page, true);
        const login = sessionRow(page, LABEL.loginFix);
        await login.hover();
        await rowButton(login, 'Stop session').click();

        /* Then */
        await expect(sessionItem(page, S.loginFix)).not.toHaveClass(/\bhas-running-pty\b/);
        await expect(planPage.getByRole('heading', {name: 'Login rework'})).toBeVisible();
        await expect(planPage.getByTestId('plan-live')).toHaveCount(0);
    });

    test('the pin on a plan’s page puts it under Pinned plans, as a row that opens the page and unpins it', async ({
        page,
    }) => {
        /* Given */
        const planPage = page.getByRole('region', {name: /^Plan in /});
        const pinnedRow = sidebar(page).locator('.pinned-plan-item').filter({hasText: 'Login rework'});
        await rowProjectLink(page, S.loginFix).click();
        await expect(plansSection(page).getByText('Login rework', {exact: true})).toBeVisible();
        await cursorToFirstPlan(page);
        await page.keyboard.press('Enter');
        await expect(planPage.getByRole('heading', {name: 'Login rework'})).toBeVisible();

        /* When */
        await planPage.getByTestId('plan-page-pin').click();

        /* Then */
        await expect(planPage.getByTestId('plan-page-pin')).toHaveAttribute('aria-pressed', 'true');
        await expect(sidebar(page).getByText('Pinned plans', {exact: true})).toBeVisible();
        await expect(pinnedRow).toHaveClass(/\bactive\b/);

        /* When */
        await page.keyboard.press('Meta+BracketLeft');
        await pinnedRow.click();

        /* Then */
        await expect(planPage.getByRole('heading', {name: 'Login rework'})).toBeVisible();

        /* When */
        await pinnedRow.getByTestId('issue-plan-pin').click();

        /* Then */
        await expect(pinnedRow).toHaveCount(0);
        await expect(sidebar(page).getByText('Pinned plans', {exact: true})).toHaveCount(0);
        await expect(planPage.getByTestId('plan-page-pin')).toHaveAttribute('aria-pressed', 'false');
    });

    test('/ filters the rows by text, and Esc clears the filter before it closes the page', async ({page}) => {
        /* Given */
        await rowProjectLink(page, S.loginFix).click();
        await expect(issueTitles(page)).toHaveCount(3);

        /* When */
        await page.keyboard.press('/');
        await page.keyboard.type('remember');

        /* Then */
        await expect(issueTitles(page)).toHaveText(['Remember me for 30 days']);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(issueTitles(page)).toHaveCount(3);
        await expect(projectPage(page)).toBeFocused();
    });

    test('the pull requests show with their plan chip, which expands the plan; Show merged adds the merged one; ↵ opens one on GitHub', async ({
        page,
        app,
    }) => {
        /* Given */
        await rowProjectLink(page, S.loginFix).click();
        const prs = projectPage(page).getByRole('region', {name: 'Pull requests'});
        const rows = prs.locator('.pp-pr');
        await expect(rows.locator('.pp-pr-title')).toHaveText([
            'Stop the login redirect loop',
            'Try a token-bucket rate limiter',
            'Bump express to 5.1',
        ]);
        await expect(rows.nth(0)).toContainText('● running');
        await expect(rows.nth(0)).toContainText('review requested');
        await expect(rows.nth(1)).toHaveClass(/\bis-draft\b/);
        await expect(rows.nth(2)).toContainText('✕ 2 failing');
        const worktrees = projectPage(page).getByRole('region', {name: 'Worktrees'});
        await expect(worktrees.locator('.pp-worktree-branch')).toHaveText([
            'main',
            'fix/1320',
            'rate-limiter',
            'cookie-store',
        ]);

        /* When */
        await rows.nth(0).getByRole('button', {name: 'in #1300'}).click();

        /* Then */
        await expect(plansSection(page).getByRole('button', {name: 'Collapse plan Login rework'})).toHaveAttribute(
            'aria-expanded',
            'true',
        );

        /* When */
        await prs.getByRole('button', {name: 'Show merged'}).click();

        /* Then */
        await expect(rows.locator('.pp-pr-title')).toHaveText([
            'Stop the login redirect loop',
            'Try a token-bucket rate limiter',
            'Bump express to 5.1',
            'Cookie store behind a port',
        ]);
        await expect(worktrees.locator('.pp-worktree').filter({hasText: 'cookie-store'})).toContainText(
            'merged in #1310 · safe to remove',
        );

        /* When */
        await projectPage(page).focus();
        await page.keyboard.press('/');
        await page.keyboard.type('express');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');

        /* Then */
        await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/pull/1331');
    });

    test('a project opened again shows its last answer, stored, until main answers: unreachable, it stays, marked stale', async ({
        page,
        app,
    }) => {
        /* Given */
        await rowProjectLink(page, S.loginFix).click();
        await expect(plansSection(page).getByText('Login rework', {exact: true})).toBeVisible();
        await page.keyboard.press('Escape');
        await rowProjectLink(page, S.chartsDarkMode).click();
        await expect(page.getByRole('region', {name: /^Project /})).not.toHaveAccessibleName('Project ' + P.acmeApi);
        await page.keyboard.press('Escape');
        await setHostStub(app, 'projectOverview', {
            [P.acmeApi]: {...acmeOverview(), github: {ok: false, reason: 'unreachable'}},
        });

        /* When */
        await rowProjectLink(page, S.loginFix).click();

        /* Then */
        await expect(projectPage(page).getByText('Couldn’t reach GitHub. Showing what it said')).toBeVisible();
        await expect(plansSection(page).getByText('Login rework', {exact: true})).toBeVisible();
        await expect(projectPage(page).getByRole('region', {name: 'Pull requests'}).locator('.pp-pr')).toHaveCount(3);
    });

    forEachAppearance(() => {
        test('the project page with its plans and issues', async ({page, home}) => {
            /* Given */
            await rowProjectLink(page, S.loginFix).click();
            await expect(issueTitles(page)).toHaveCount(3);

            /* When */
            await cursorToFirstPlan(page);
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');

            /* Then */
            await expect(issueTitles(page)).toHaveCount(8);
            await expectScreen(page, 'project-page-plans', {
                mask: [projectPage(page).getByText(home.projectPath(P.acmeApi), {exact: true})],
            });
        });
    });
});

forEachAppearance(() => {
    test('the project page, with its header and its sessions', async ({page, home}) => {
        /* When */
        await rowProjectLink(page, S.loginFix).click();

        /* Then */
        await expect(projectPage(page)).toBeVisible();
        // The fixture home is a fresh temporary directory each run.
        await expectScreen(page, 'project-page', {
            mask: [projectPage(page).getByText(home.projectPath(P.acmeApi), {exact: true})],
        });
    });
});

test.describe('merge queue', () => {
    test.use({
        stubs: {projectOverview: {[P.acmeApi]: acmeQueueOverview()}, plans: plansStub(), mergeQueue: mergeQueueStub()},
    });

    function queueSection(page: Page) {
        return projectPage(page).getByRole('region', {name: 'Merge queue'});
    }

    test('the queue shows over Pull requests, its rows join the cursor, Retry and + Queue reach main, and Nudge asks first with the exact message', async ({
        page,
        app,
    }) => {
        /* Given */
        await rowProjectLink(page, S.loginFix).click();
        const queue = queueSection(page);
        const prs = projectPage(page).getByRole('region', {name: 'Pull requests'});

        /* Then */
        await expect(projectPage(page).locator('.pp-section h2').nth(0)).toHaveText('Merge queue');
        await expect(projectPage(page).locator('.pp-section h2').nth(1)).toHaveText('Pull requests');
        await expect(queue.locator('.pp-section-head')).toContainText('3 queued · 1 held · 1 failed');
        await expect(queue.locator('.pp-section-head')).toContainText('Clears in about 105 min');
        const head = queue.locator('.pp-mq-head');
        await expect(head).toContainText('Stop the login redirect loop');
        await expect(head).toContainText('approved by ana');
        await expect(head).toContainText('merges in ~9 min');
        await expect(head).toContainText('Required checks 3 of 5');
        await expect(head).toContainText('Integration tests');
        await expect(head.getByRole('button', {name: 'session “' + LABEL.loginFix + '”'})).toBeVisible();
        const behind = queue.locator('.pp-mq-rail .pp-mq-entry');
        await expect(behind).toHaveCount(3);
        await expect(behind.nth(0)).toContainText('Bump express to 5.1');
        await expect(behind.nth(0)).toContainText('next');
        await expect(behind.nth(0)).toContainText('~33 min');
        await expect(behind.nth(1).locator('.pp-mq-member-at')).toHaveText(['↑3', '↑2', '↑1']);
        await expect(behind.nth(1)).toContainText('stack · 3 PRs · merges as one');
        await expect(behind.nth(2)).toHaveClass(/\bis-held\b/);
        await expect(behind.nth(2)).toContainText('passed over until @sam reviews');
        const failed = queue.locator('.pp-mq-entry.is-failed');
        await expect(failed).toContainText('CI failed');
        await expect(failed).toContainText('Unit tests');
        await expect(failed.getByRole('button', {name: 'Fix in session'})).toBeVisible();
        await expect(queue.locator('.pp-mq-entry.is-unknown')).toContainText('Paused by an admin until Friday');
        await expect(queue.locator('.pp-mq-outside .pp-pill')).toHaveText([
            '#1330 draft',
            '#1371 waits until fix/1320 merges',
            '#1370 approved, not queued',
        ]);
        await expect(prs.locator('.pp-pr').filter({hasText: 'Stop the login redirect loop'})).toContainText(
            'merging · 1st',
        );
        await expect(prs.locator('.pp-pr').filter({hasText: 'Bump express to 5.1'})).toContainText('queued · 2nd');
        await expect(prs.locator('.pp-pr').filter({hasText: 'Log the webhook retries'})).toContainText('queue failed');
        await expect
            .poll(async () => (await mergeQueueRequests(app)).find((request) => request.call === 'queueSettleNudges'))
            .toEqual({call: 'queueSettleNudges', args: ['acme/api', [{number: 1350, reviewer: 'sam'}]]});

        /* When */
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');

        /* Then */
        await expect(behind.nth(0)).toHaveClass(/\bis-cursor\b/);
        await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/pull/1331');

        /* When */
        await failed.getByRole('button', {name: 'Retry'}).click();

        /* Then */
        await expect
            .poll(async () => (await mergeQueueRequests(app)).filter((request) => request.call === 'queueRetry'))
            .toEqual([{call: 'queueRetry', args: ['acme/api', 1360]}]);

        /* When */
        await prs
            .locator('.pp-pr')
            .filter({hasText: 'Add a health endpoint'})
            .getByRole('button', {name: '+ Queue'})
            .click();

        /* Then */
        await expect
            .poll(async () => (await mergeQueueRequests(app)).filter((request) => request.call === 'queueOptIn'))
            .toEqual([{call: 'queueOptIn', args: ['acme/api', 1370]}]);

        /* When */
        await answerDialogs(page, false);
        await behind.nth(2).getByRole('button', {name: 'Nudge sam'}).click();

        /* Then */
        const message = nudgeMessage(
            {number: 1350, title: 'Bump TypeScript to 5.9', url: 'https://github.com/acme/api/pull/1350'},
            'sam',
        );
        await expect.poll(() => dialogsAsked(page)).toEqual([expect.stringContaining(message)]);
        expect((await mergeQueueRequests(app)).filter((request) => request.call === 'queueNudge')).toEqual([]);
    });

    forEachAppearance(() => {
        test('the merge queue section', async ({page, home}) => {
            /* When */
            await rowProjectLink(page, S.loginFix).click();

            /* Then */
            await expect(queueSection(page).locator('.pp-mq-head')).toContainText('merges in ~9 min');
            await expectScreen(page, 'project-page-merge-queue', {
                mask: [projectPage(page).getByText(home.projectPath(P.acmeApi), {exact: true})],
            });
        });
    });
});

test.describe('GitHub CLI signed out', () => {
    test.use({stubs: {projectOverview: {[P.acmeApi]: {...acmeOverview(), github: {ok: false, reason: 'signed-out'}}}}});

    test('one message stands in for plans and pull requests, with Try again and Copy command', async ({page, app}) => {
        /* When */
        await rowProjectLink(page, S.loginFix).click();

        /* Then */
        const message = projectPage(page).getByRole('status', {name: 'GitHub'});
        await expect(message).toContainText('Plans, issues and pull requests come from the GitHub CLI');
        await expect(message).toContainText('Run gh auth login in a terminal, then try again.');
        await expect(projectPage(page).getByRole('region', {name: 'Plans & issues'})).toHaveCount(0);
        await expect(projectPage(page).getByRole('region', {name: 'Pull requests'})).toHaveCount(0);
        await expect(projectPage(page).getByRole('region', {name: 'Sessions'})).toBeVisible();
        await expect(message.getByRole('button', {name: 'Try again'})).toBeVisible();

        /* When */
        await message.getByRole('button', {name: 'Copy command'}).click();

        /* Then */
        await expect.poll(() => clipboardWrites(app)).toEqual(['gh auth login']);
    });
});
