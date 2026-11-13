/**
 * The Merge manager's page (#439): ⌘⇧L opens it from anywhere, the
 * terminal included, on its tiles and its lanes, with the head as a card and
 * the selected row's detail; J moves the selection, Esc goes back to the
 * session, and ⌘⇧L opens it again.
 *
 * What the tiles count and how the lanes are ordered is unit tested
 * (test/merge-manager-page.test.ts).
 */
import {test, expect} from '../support/test';
import {openSession, terminalHeader} from '../support/app';
import {pushEvent} from '../support/main-process';
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

test('⌘⇧L opens the Merge manager from the terminal on its lanes, J moves through them and Esc goes back', async ({
    page,
    app,
    home,
}) => {
    /* Given: a Switchboard lane with its head, one waiting and one held for a review */
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
    await expect(manager.getByRole('group', {name: 'Summary'})).toContainText('CI runs saved');
    await expect(manager.getByRole('group', {name: REPO})).toContainText('Switchboard lane');
    await expect(manager.getByRole('list', {name: 'Where the head is'})).toContainText('Updated on the trunk');
    await expect(manager.getByRole('option', {name: /#1320 Paginate the export/})).toContainText('will conflict');
    await expect(manager.getByRole('complementary')).toContainText('#1300 Stop the login redirect loop');
    await expect(manager.getByRole('button', {name: /Open session/})).toBeVisible();

    /* When */
    await page.keyboard.press('j');
    await page.keyboard.press('j');

    /* Then: the held one, with Nudge */
    await expect(manager.getByRole('complementary')).toContainText('#1330 Rate-limit webhooks');
    await expect(manager.getByRole('button', {name: /Nudge ana/})).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(manager).toHaveCount(0);
    await expect(terminalHeader(page)).toBeVisible();

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');

    /* Then: the selection is where it was */
    await expect(mergePage(page).getByRole('complementary')).toContainText('#1330 Rate-limit webhooks');
});
