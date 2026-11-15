/**
 * The project page's screenshots (#173, #174, #315): its header and sessions,
 * its plans and issues with a plan expanded, and the merge queue section, from
 * a stubbed overview.
 *
 * What the page does (opening it, its keys, the plans, pull requests,
 * worktrees, pins, the stored answer, the merge queue's buttons and a signed
 * out `gh`) is tested against the renderer in
 * component/tests/project-page.spec.ts. The page's own state and the Sessions
 * section's choice are unit tested in test/project-page-slice.test.ts, its
 * rows and keys in test/project-page-plans.test.ts; the pull requests,
 * worktrees and edge states in test/project-page-prs-worktrees.test.ts; the
 * route in test/main-area-slice.test.ts.
 */
import {expect, forEachAppearance, screenTest, test} from '../support/test';
import {expectScreen} from '../support/app';
import {sessionItem} from '../support/session-list';
import {P, S} from '../fixtures/standard';
import {acmeOverview, plansStub} from '../fixtures/plans';
import {acmeQueueOverview, mergeQueueStub} from '../fixtures/merge-queue';
import type {Page} from '@playwright/test';

function projectPage(page: Page) {
    return page.getByRole('region', {name: 'Project ' + P.acmeApi});
}

/** A row's project label: the way into the project's page. */
function rowProjectLink(page: Page, sessionId: string) {
    return sessionItem(page, sessionId).getByTestId('project-link');
}

test.describe('plans and issues', () => {
    test.use({stubs: {projectOverview: {[P.acmeApi]: acmeOverview()}, plans: plansStub()}});

    /** The issue rows under the plans and under "Not in a plan", by their titles, in order. */
    function issueTitles(page: Page) {
        return projectPage(page).getByRole('region', {name: 'Plans & issues'}).locator('.pp-issue .pp-issue-title');
    }

    forEachAppearance(() => {
        screenTest('the project page with its plans and issues', async ({page, home}) => {
            /* Given */
            await rowProjectLink(page, S.loginFix).click();
            await expect(issueTitles(page)).toHaveCount(3);

            /* When: the cursor on the first plan, past the three pull requests, and the plan expanded */
            for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
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
    screenTest('the project page, with its header and its sessions', async ({page, home}) => {
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

    forEachAppearance(() => {
        screenTest('the merge queue section', async ({page, home}) => {
            /* When */
            await rowProjectLink(page, S.loginFix).click();

            /* Then */
            await expect(
                projectPage(page).getByRole('region', {name: 'Merge queue'}).locator('.pp-mq-head'),
            ).toContainText('merges in ~10 min');
            await expectScreen(page, 'project-page-merge-queue', {
                mask: [projectPage(page).getByText(home.projectPath(P.acmeApi), {exact: true})],
            });
        });
    });
});
