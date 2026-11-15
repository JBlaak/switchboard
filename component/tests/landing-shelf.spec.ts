/**
 * The Landing shelf: the user's landed PRs as one line under the session
 * list, with when the next one merges; hovered, a card with each PR's wait;
 * clicked, the same rows unfolded; and when one merges, the line says so.
 *
 * The times, the dots and the colours are unit tested
 * (test/merge-manager-landing.test.ts).
 */
import {test, expect} from '../support/test';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {mergeManagerState} from '../../src/domain/merge-manager/landed';
import {landedKey} from '../../src/domain/merge-manager/model';
import type {LandedPullRequest, LaneStage} from '../../src/domain/merge-manager/model';

const REPO = 'acme/api';
const MIN = 60_000;

function landedPr(number: number, title: string, minutesAgo: number, stage: LaneStage): LandedPullRequest {
    return {
        key: landedKey(REPO, number),
        repository: REPO,
        number,
        title,
        url: `https://github.com/${REPO}/pull/${number}`,
        headRef: 'fix/' + number,
        lane: 'switchboard',
        landedAt: FIXTURE_NOW - minutesAgo * MIN,
        stage,
        setAside: null,
        errand: null,
    };
}

const HEAD = landedPr(1300, 'Stop the login redirect loop', 50, {kind: 'head', step: 'merging'});
const WAITING = landedPr(1320, 'Paginate the export', 40, {kind: 'waiting', willConflict: false, position: null});
const HELD = landedPr(1330, 'Rate-limit webhooks', 30, {
    kind: 'held',
    reason: {kind: 'review', reviewer: 'ana', team: false},
});
// Merged an hour ago, 20 minutes after it landed: the lane's cycle.
const EARLIER = landedPr(1290, 'Retry the cookie refresh', 80, {kind: 'merged', at: FIXTURE_NOW - 60 * MIN});

test('the shelf shows how long until the next merge, each wait on hover, and the rows when unfolded', async ({
    page,
    api,
}) => {
    /* Given */
    const shelf = page.getByTestId('landing-shelf');
    await expect(shelf).toHaveCount(0);

    /* When */
    await api.emit('onMergeManagerChanged', mergeManagerState([EARLIER, HEAD, WAITING, HELD], new Map()));

    /* Then: three landed, the head merges in a minute */
    const line = shelf.getByRole('button', {name: /^Landing: 3 pull requests/});
    await expect(line).toHaveAttribute('aria-label', 'Landing: 3 pull requests, #1300 merges in about 1m');
    await expect(page.getByTestId('landing-eta')).toHaveText('1m');

    /* When */
    await line.hover();

    /* Then: each one's wait, the held one without one, and what merged */
    const card = page.getByTestId('landing-card');
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', {name: /Paginate the export #1320/})).toContainText('21m');
    await expect(card.getByRole('button', {name: /Rate-limit webhooks #1330/})).toContainText('Held · @ana');
    await expect(card.getByRole('button', {name: /Retry the cookie refresh #1290/})).toContainText('1h ago');

    /* When */
    await line.click();

    /* Then */
    await expect(line).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toHaveCount(0);
    await expect(shelf.locator('#landing-shelf-body').getByRole('button', {name: /Paginate the export/})).toBeVisible();
});

test('when the head merges the line says so, and it tops Just merged', async ({page, api}) => {
    /* Given */
    await api.emit('onMergeManagerChanged', mergeManagerState([EARLIER, HEAD, WAITING], new Map()));
    await expect(page.getByTestId('landing-eta')).toHaveText('1m');

    /* When */
    const merged = {...HEAD, stage: {kind: 'merged' as const, at: FIXTURE_NOW}};
    await api.emit('onMergeManagerChanged', mergeManagerState([EARLIER, merged, WAITING], new Map()));

    /* Then */
    await expect(page.getByTestId('landing-eta')).toHaveText('✓ #1300');
    const line = page.getByTestId('landing-shelf').getByRole('button', {name: /^Landing/});
    await expect(line).toHaveAttribute('aria-label', 'Landing: 1 pull request, #1300 just merged');
    await line.hover();
    await expect(
        page.getByTestId('landing-card').getByRole('button', {name: /Stop the login redirect loop #1300/}),
    ).toContainText('just now');
});
