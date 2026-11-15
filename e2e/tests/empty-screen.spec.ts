/**
 * The empty screen's screenshots: a first launch with nothing indexed and
 * nothing running, Patch out with its family, and the managers beside Patch
 * on a tall and a short window, counted and calm.
 *
 * What each of these screens does — Patch's lines for the board main gives
 * it, the family, a reaction beating a slow gather, the managers following
 * main's counts and lanes — is tested in component/tests/empty-screen.spec.ts;
 * what follows only waits for each screen to settle before its comparison.
 */
import {screenTest, expect, forEachAppearance, test} from '../support/test';
import {expectScreen, openSession, sidebar} from '../support/app';
import {pushEvent, setContentSize} from '../support/main-process';
import {LABEL, S, emptyFixture, standardFixture} from '../fixtures/standard';
import type {Page} from '@playwright/test';
import type {InboxSummary} from '../../src/domain/inbox/model';

test.use({fixture: emptyFixture()});

// ── Patch on the empty screen ──

const FIRST_LINE = 'Zzz… nothing running. Wake me when you start something.';

/** Patch's speech bubble, by what it says. */
const says = (page: Page, line: string | RegExp) => page.locator('#placeholder').getByText(line);

forEachAppearance(() => {
    screenTest('greets with Patch and an empty session list', async ({page}) => {
        /* Then */
        await expect(says(page, FIRST_LINE)).toBeVisible();
        await expectScreen(page, 'empty-screen');
    });
});

test.describe('patch', () => {
    test.describe('with its family', () => {
        test.use({fixture: standardFixture()});

        screenTest('a running session is out with the family', async ({page, home}) => {
            /* Given */
            await expect(says(page, FIRST_LINE)).toBeVisible();
            await openSession(page, home, LABEL.loginFix, S.loginFix);

            /* When */
            await sidebar(page).getByText('Recent', {exact: true}).click();

            /* Then */
            await expect(says(page, 'Missed you.')).toBeVisible();
            await expect(page.getByTestId('patch-family').locator(`[data-member="${S.loginFix}"]`)).toBeVisible();
            await expectScreen(page, 'empty-screen-family');
        });
    });
});

// ── The managers (#416) ──

/** A manager's figure, by its accessible name. */
const manager = (page: Page, name: string | RegExp) => page.getByTestId('patch-managers').getByRole('button', {name});

/** The scene element a manager's pose is drawn from. */
const pose = (page: Page, kind: 'bug' | 'issue') => page.locator(`[data-manager="${kind}"] .patch-mgr-scene`);

/** Main's push after a poll, for both managers set up. */
function summary(bug: [number, number], issue: number): InboxSummary {
    return {
        bug: {unread: bug[0], urgent: bug[1]},
        issue: {unread: issue, urgent: 0},
        configured: {bug: true, issue: true},
        triaging: [],
    };
}

test.describe('managers', () => {
    forEachAppearance(() => {
        screenTest('stand on the floor beside Patch, counted and then calm', async ({page, app}) => {
            /* Given */
            await expect(says(page, FIRST_LINE)).toBeVisible();

            /* When */
            await pushEvent(app, 'inbox:changed', summary([3, 1], 2));

            /* Then */
            await expect(manager(page, 'Issue manager, 2 unread')).toBeVisible();
            await expectScreen(page, 'empty-screen-managers');

            /* When */
            await pushEvent(app, 'inbox:changed', summary([0, 0], 0));

            /* Then */
            await expect(pose(page, 'issue')).toHaveClass(/patch-mgr-s-calm/);
            await expectScreen(page, 'empty-screen-managers-calm');
        });
    });

    screenTest('stand in a row under Patch in a window too short for the family card', async ({page, app}) => {
        /* Given */
        await expect(says(page, FIRST_LINE)).toBeVisible();
        await pushEvent(app, 'inbox:changed', summary([1, 0], 4));

        /* When */
        await setContentSize(app, 1280, 700);

        /* Then */
        await expect(manager(page, 'Issue manager, 4 unread')).toBeVisible();
        await expectScreen(page, 'empty-screen-managers-short');
    });
});
