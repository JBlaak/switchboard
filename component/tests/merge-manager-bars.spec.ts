/**
 * The Merge manager's progress bars move between reads: the live stretch of
 * the head's timeline (its card on the page) and the Landing shelf's head
 * row fill toward the step's expected time, and slide once it runs past it.
 *
 * Where a bar is at a moment is unit tested (test/merge-manager-progress.test.ts).
 */
import {test, expect} from '../support/test';
import {openSession} from '../support/running-session';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {mergeManagerState} from '../../src/domain/merge-manager/landed';
import {landedKey} from '../../src/domain/merge-manager/model';
import type {HeadStep, LandedFacts, LandedPullRequest} from '../../src/domain/merge-manager/model';
import type {MergeManagerPageFacts} from '../../src/domain/merge-manager/page';
import type {Page} from '@playwright/test';

const REPO = 'acme/api';
const MIN = 60_000;
const RUN_MS = 10 * MIN;

const FACTS: MergeManagerPageFacts = {
    savedThisWeek: {'update-not-pushed': 0, 'run-cancelled': 0, 'conflict-found': 0},
    savedByRepository: {},
    errands: [],
    checkouts: {},
    runMs: {[REPO]: RUN_MS},
};

function head(step: HeadStep): LandedPullRequest {
    return {
        key: landedKey(REPO, 1300),
        repository: REPO,
        number: 1300,
        title: 'Stop the login redirect loop',
        url: `https://github.com/${REPO}/pull/1300`,
        headRef: 'fix/1300',
        lane: 'switchboard',
        landedAt: FIXTURE_NOW - 50 * MIN,
        stage: {kind: 'head', step},
        setAside: null,
        errand: null,
    };
}

/** One of two checks passed, the first started two minutes ago. */
const CHECKS: LandedFacts = {
    approvedBy: ['ana'],
    checks: [
        {name: 'Unit tests', state: 'passed', startedAt: FIXTURE_NOW - 2 * MIN},
        {name: 'e2e', state: 'running', startedAt: FIXTURE_NOW - 2 * MIN},
    ],
};

async function landHead(page: Page, api: Parameters<typeof openSession>[1], step: HeadStep): Promise<void> {
    await api.emit(
        'onMergeManagerChanged',
        mergeManagerState([head(step)], new Map(), {facts: new Map([[landedKey(REPO, 1300), CHECKS]])}),
    );
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+Shift+KeyL');
}

/** The live stretch on the head's card: its timeline's one timed bar. */
function liveBar(page: Page) {
    return page
        .getByRole('region', {name: 'Merge manager'})
        .getByRole('option', {name: /#1300 Stop the login redirect loop/})
        .locator('.mm-prt-bar');
}

test.use({answers: {mergeManagerPage: FACTS}, fakeTimers: true});

test('while the checks run their bar fills toward one CI run, and slides once they run past it', async ({
    page,
    api,
}) => {
    /* Given */
    await landHead(page, api, 'checks');
    const bar = liveBar(page);

    /* Then: one bar, the checks', filling */
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute('data-bar', 'filling');
    const fill = bar.locator('span');
    // Never behind the read: one of two checks passed.
    await expect(fill).toHaveAttribute('style', /--bar-from: 0\.5;/);
    await expect(fill).toHaveAttribute('style', /animation-duration: 4[5-8]\d{4}ms/);

    /* When: the run goes past its ten minutes */
    await page.clock.fastForward(8 * MIN + 1000);

    /* Then */
    await expect(bar).toHaveAttribute('data-bar', 'indeterminate');
});

for (const step of ['updating', 'merging'] as const) {
    test(`while ${step} the head's live stretch fills toward a minute from when it was seen, then slides`, async ({
        page,
        api,
    }) => {
        /* Given */
        await landHead(page, api, step);
        const bar = liveBar(page);

        /* Then */
        await expect(bar).toHaveAttribute('data-bar', 'filling');
        await expect(bar.locator('span')).toHaveAttribute('style', /animation-duration: [5-6]\d{4}ms/);

        /* When */
        await page.clock.fastForward(MIN + 1000);

        /* Then */
        await expect(bar).toHaveAttribute('data-bar', 'indeterminate');
    });
}

test("the Landing shelf's head bar fills while the checks run, and slides once they run past the lane's share", async ({
    page,
    api,
}) => {
    /* Given: no merges yet, so the lane's default cycle */
    await api.emit(
        'onMergeManagerChanged',
        mergeManagerState([head('checks')], new Map(), {facts: new Map([[landedKey(REPO, 1300), CHECKS]])}),
    );
    const line = page.getByTestId('landing-shelf').getByRole('button', {name: /^Landing: 1 pull request/});

    /* When */
    await line.click();

    /* Then */
    const bar = page.locator('#landing-shelf-body .landing-bar');
    await expect(bar).toHaveAttribute('data-bar', 'filling');

    /* When */
    await page.clock.fastForward(60 * MIN);

    /* Then */
    await expect(bar).toHaveAttribute('data-bar', 'indeterminate');
});
