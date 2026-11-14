/**
 * The Merge manager's page (#439): ⌘⇧L opens it from anywhere, the
 * terminal included, on its lanes, with the head as a card, when each PR is
 * expected to merge and the next hour on a timeline; J opens the side view
 * and moves through the rows, Esc closes the side view and then goes back to
 * the session, and ⌘⇧L opens it again.
 *
 * How the lanes are ordered and the times worked out is unit tested
 * (test/merge-manager-page.test.ts, test/merge-manager-times.test.ts).
 */
import {test, expect} from '../support/test';
import {openSession, terminalHeader} from '../support/app';
import {pushEvent, stubMergeManagerPage} from '../support/main-process';
import {FIXTURE_NOW} from '../support/fixture-home';
import {LABEL, S} from '../fixtures/standard';
import {mergeManagerState} from '../../src/domain/merge-manager/landed';
import {landedKey} from '../../src/domain/merge-manager/model';
import type {LandedPullRequest, LaneStage} from '../../src/domain/merge-manager/model';
import type {Page} from '@playwright/test';

const REPO = 'acme/api';

function landedPr(number: number, title: string, minutesAgo: number, stage: LaneStage): LandedPullRequest {
    return {
        key: landedKey(REPO, number),
        repository: REPO,
        number,
        title,
        url: `https://github.com/${REPO}/pull/${number}`,
        headRef: 'fix/' + number,
        lane: 'switchboard',
        landedAt: FIXTURE_NOW - minutesAgo * 60_000,
        stage,
        setAside: null,
        errand: null,
    };
}

function mergePage(page: Page) {
    return page.getByRole('region', {name: 'Merge manager'});
}

test('⌘⇧L opens the Merge manager on its lanes and times, J opens the side view, and Esc closes it, then the page', async ({
    page,
    app,
    home,
}) => {
    /* Given: a Switchboard lane with its head, one waiting and one held for a review, and CI that takes 11 min */
    await stubMergeManagerPage(app, {
        savedThisWeek: {'update-not-pushed': 2, 'run-cancelled': 1, 'conflict-found': 0},
        savedByRepository: {},
        errands: [],
        checkouts: {},
        runMs: {[REPO]: 11 * 60_000},
    });
    await pushEvent(
        app,
        'merge-manager:changed',
        mergeManagerState(
            [
                landedPr(1300, 'Stop the login redirect loop', 50, {kind: 'head', step: 'checks'}),
                landedPr(1320, 'Paginate the export', 40, {kind: 'waiting', willConflict: true, position: null}),
                landedPr(1330, 'Rate-limit webhooks', 30, {
                    kind: 'held',
                    reason: {kind: 'review', reviewer: 'ana', team: false},
                }),
            ],
            new Map(),
        ),
    );
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');

    /* Then */
    const manager = mergePage(page);
    await expect(manager.getByRole('heading', {name: 'Merge manager'})).toBeVisible();
    await expect(manager).toContainText('Merging on this Mac');
    await expect(manager.getByRole('group', {name: 'Summary'})).toHaveCount(0);
    await expect(manager.getByRole('group', {name: REPO})).toContainText('Switchboard lane');
    await expect(manager.getByRole('list', {name: 'Where the head is'})).toContainText('Updated on the trunk');
    await expect(manager).toContainText('3 CI runs saved this week');
    await expect(manager.getByRole('group', {name: REPO})).toContainText('clear by ~');
    await expect(manager.getByRole('region', {name: 'Coming up'})).toContainText('#1320');
    const waiting = manager.getByRole('option', {name: /#1320 Paginate the export/});
    await expect(waiting).toContainText('will conflict');
    await expect(waiting).toContainText(/in \d+ min/);
    await expect(manager.getByRole('option', {name: /#1330 Rate-limit webhooks/})).toContainText(
        'keeps its place until it is reviewed',
    );
    await expect(manager.getByRole('complementary')).toHaveCount(0);

    /* When */
    await page.keyboard.press('j');

    /* Then: the side view opens on the head */
    await expect(manager.getByRole('complementary')).toContainText('#1300 Stop the login redirect loop');
    await expect(manager.getByRole('button', {name: /Open session/})).toBeVisible();

    /* When */
    await page.keyboard.press('j');

    /* Then: the waiting one, with when it merges */
    await expect(manager.getByRole('complementary')).toContainText('Expected to merge');
    await expect(manager.getByRole('complementary')).toContainText('update and checks');

    /* When */
    await page.keyboard.press('j');

    /* Then: the held one, with Nudge */
    await expect(manager.getByRole('complementary')).toContainText('#1330 Rate-limit webhooks');
    await expect(manager.getByRole('button', {name: /Nudge ana/})).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then: the side view closes, the page stays */
    await expect(manager.getByRole('complementary')).toHaveCount(0);
    await expect(manager).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(manager).toHaveCount(0);
    await expect(terminalHeader(page)).toBeVisible();

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');
    await page.keyboard.press('j');

    /* Then: the selection is where it was */
    await expect(mergePage(page).getByRole('complementary')).toContainText('#1330 Rate-limit webhooks');
});

test('with nothing landed the page shows the Merge manager large and how to land a pull request', async ({
    page,
    home,
}) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');

    /* Then */
    const manager = mergePage(page);
    await expect(manager.getByRole('heading', {name: 'Nothing to land yet'})).toBeVisible();
    await expect(manager.locator('.mm-empty-figure .patch-manager')).toHaveCSS('width', '180px');
});
