/**
 * The Merge manager's page (#439): ⌘⇧L opens it from anywhere, the
 * terminal included, on every PR by status: a chip per group, Coming up with
 * the next hour on a timeline (parked PRs as flags on their track, the
 * repository's not landed ones counted), the groups that ask for attention
 * as cards with the PR's timeline and what is happening now, the rest as
 * compact rows, Drafts folded. J opens the side view and moves through the
 * groups top to bottom, Esc closes the side view and then goes back to the
 * session, and ⌘⇧L opens it again.
 *
 * Which group a PR is in, its timeline, the times and the flags are unit
 * tested (test/merge-manager-status.test.ts, test/merge-manager-times.test.ts
 * and the like).
 */
import {test, expect} from '../support/test';
import {openSession} from '../support/running-session';
import {terminalHeader} from '../../e2e/support/app';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {mergeManagerState} from '../../src/domain/merge-manager/landed';
import {landedKey} from '../../src/domain/merge-manager/model';
import type {LandedPullRequest, LaneStage} from '../../src/domain/merge-manager/model';
import type {MergeManagerPageFacts} from '../../src/domain/merge-manager/page';
import type {OpenPullRequest} from '../../src/domain/merge-manager/not-landed';
import type {Page} from '@playwright/test';

const REPO = 'acme/api';

/** What main's page facts are with nothing saved, no errands and no CI runs timed. */
const NO_FACTS: MergeManagerPageFacts = {
    savedThisWeek: {'update-not-pushed': 0, 'run-cancelled': 0, 'conflict-found': 0},
    savedByRepository: {},
    errands: [],
    checkouts: {},
    runMs: {},
};

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

/** One of the user's open PRs, not landed: approved and green unless `over` says otherwise. */
function openPr(number: number, title: string, hoursAgo: number, over: Partial<OpenPullRequest> = {}): OpenPullRequest {
    return {
        repository: REPO,
        number,
        title,
        url: `https://github.com/${REPO}/pull/${number}`,
        isDraft: false,
        createdAt: FIXTURE_NOW - hoursAgo * 3_600_000,
        headRef: 'feat/' + number,
        reviewDecision: 'APPROVED',
        mergeable: 'MERGEABLE',
        checks: 'success',
        reviewRequested: [],
        changesRequestedBy: [],
        approvedBy: ['ana'],
        ...over,
    };
}

function mergePage(page: Page) {
    return page.getByRole('region', {name: 'Merge manager'});
}

test.use({answers: {mergeManagerPage: NO_FACTS}});

test('⌘⇧L opens the Merge manager by status, J goes through the groups top to bottom, and Esc closes the side view, then the page', async ({
    page,
    api,
}) => {
    /* Given: a Switchboard lane with its head running checks, one that will conflict and one held for a review, CI that takes 11 min, and three open PRs not landed: one ready, one in review and a draft */
    api.answer('mergeManagerPage', {
        ...NO_FACTS,
        savedThisWeek: {'update-not-pushed': 2, 'run-cancelled': 1, 'conflict-found': 0},
        runMs: {[REPO]: 11 * 60_000},
    });
    api.answer('mergeManagerNotLanded', {
        pullRequests: [
            openPr(1400, 'Cache the avatars', 1),
            openPr(1410, 'Try a new header', 2, {isDraft: true}),
            openPr(1420, 'Log slow queries', 3, {reviewDecision: 'REVIEW_REQUIRED', reviewRequested: ['bo']}),
        ],
        fetchedAt: FIXTURE_NOW,
        failed: false,
    });
    await api.emit(
        'onMergeManagerChanged',
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
    await openSession(page, api, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');

    /* Then: the header, a chip per group, Coming up and the groups */
    const manager = mergePage(page);
    await expect(manager.getByRole('heading', {name: 'Merge manager'})).toBeVisible();
    await expect(manager).toContainText('Merging on this Mac');
    await expect(manager).toContainText('3 CI runs saved this week');
    const chips = manager.getByRole('navigation', {name: 'Groups'});
    await expect(chips.getByRole('button')).toHaveText([
        'Conflicts1',
        'Checks running1',
        'Ready to land1',
        'In line1',
        'Waiting on review1',
        'Drafts1',
    ]);
    const comingUp = manager.getByRole('region', {name: 'Coming up'});
    await expect(comingUp).toContainText('#1320');
    await expect(comingUp).toContainText('Switchboard lane');
    await expect(comingUp).toContainText('clear by ~');
    await expect(comingUp.getByRole('button', {name: '‖ #1330'})).toBeVisible();
    await expect(comingUp.getByRole('button', {name: '1 ready to land'})).toBeVisible();
    await expect(comingUp.getByRole('button', {name: '1 waiting on review'})).toBeVisible();
    await expect(comingUp).toContainText('2 landed: next ~');
    await expect(comingUp).toContainText('1 parked');
    await expect(comingUp).toContainText('+ 3 not landed');

    /* Then: a card with its pill, its kind, when it merges, its timeline and what happens now */
    const conflicts = manager.getByRole('group', {name: 'Conflicts'});
    const willConflict = conflicts.getByRole('option', {name: /#1320 Paginate the export/});
    await expect(willConflict).toContainText('Landed · Switchboard lane · 2nd');
    await expect(willConflict).toContainText(/in \d+ min/);
    await expect(willConflict.getByRole('img')).toHaveAttribute('aria-label', /In line/);
    await expect(willConflict).toContainText('Now');
    await expect(manager.getByRole('group', {name: 'Checks running'}).getByRole('option')).toContainText(
        '#1300 Stop the login redirect loop',
    );

    /* Then: compact rows, with Land it on the ready one and Nudge on the held one */
    const ready = manager.getByRole('group', {name: 'Ready to land'}).getByRole('option', {name: /#1400/});
    await expect(ready.getByRole('button', {name: 'Land it'})).toBeVisible();
    await expect(
        manager.getByRole('group', {name: 'In line'}).getByRole('option', {name: /#1330 Rate-limit webhooks/}),
    ).toBeVisible();
    await expect(manager.getByRole('group', {name: 'In line'}).getByRole('button', {name: /Nudge ana/})).toBeVisible();

    /* Then: Drafts is folded */
    const drafts = manager.getByRole('group', {name: 'Drafts'});
    await expect(drafts.getByRole('button', {name: 'Show 1'})).toBeVisible();
    await expect(drafts.getByRole('option')).toHaveCount(0);
    await expect(manager.getByRole('complementary')).toHaveCount(0);

    /* When */
    await page.keyboard.press('j');

    /* Then: the side view opens on the top group's PR */
    await expect(manager.getByRole('complementary')).toContainText('#1320 Paginate the export');
    await expect(manager.getByRole('complementary')).toContainText('Expected to merge');

    /* When */
    await page.keyboard.press('j');

    /* Then: the head */
    await expect(manager.getByRole('complementary')).toContainText('#1300 Stop the login redirect loop');
    await expect(manager.getByRole('complementary').getByRole('button', {name: /Open session/})).toBeVisible();

    /* When */
    await page.keyboard.press('j');

    /* Then: the ready one, not landed */
    await expect(manager.getByRole('complementary')).toContainText('#1400 Cache the avatars');
    await expect(manager.getByRole('complementary')).toContainText('If you land it now');

    /* When */
    await page.keyboard.press('j');

    /* Then: the held one, with Nudge */
    await expect(manager.getByRole('complementary')).toContainText('#1330 Rate-limit webhooks');
    await expect(manager.getByRole('complementary').getByRole('button', {name: /Nudge ana/})).toBeVisible();

    /* When */
    await page.keyboard.press('j');
    await page.keyboard.press('j');

    /* Then: on the draft, its folded group shows it */
    await expect(manager.getByRole('complementary')).toContainText('#1410 Try a new header');
    await expect(drafts.getByRole('option', {name: /#1410 Try a new header/})).toBeVisible();

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
    await page.keyboard.press('k');

    /* Then: the selection is where it was */
    await expect(mergePage(page).getByRole('complementary')).toContainText('#1410 Try a new header');
});

test('parked PRs stand as one flag on their track, which selects the first of them, and a card offers its actions', async ({
    page,
    api,
}) => {
    /* Given: a head, and behind it one an errand gave up on and one a fix errand works on */
    api.answer('mergeManagerPage', {...NO_FACTS, runMs: {[REPO]: 11 * 60_000}});
    await api.emit(
        'onMergeManagerChanged',
        mergeManagerState(
            [
                landedPr(1300, 'Stop the login redirect loop', 50, {kind: 'head', step: 'merging'}),
                landedPr(1340, 'Retry the upload', 40, {kind: 'needsYou', reason: {kind: 'errand-stopped'}}),
                landedPr(1350, 'Trim the logs', 30, {kind: 'fixing', cause: 'checks'}),
            ],
            new Map(),
        ),
    );
    await openSession(page, api, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');

    /* Then */
    const manager = mergePage(page);
    const flag = manager.getByRole('region', {name: 'Coming up'}).getByRole('button', {name: '! 2'});
    await expect(flag).toHaveAttribute('title', /#1340.*#1350/);
    const needsYou = manager.getByRole('group', {name: 'Needs you'}).getByRole('option', {name: /#1340/});
    await expect(needsYou.getByRole('button', {name: /Try again/})).toBeVisible();
    await expect(needsYou.getByRole('button', {name: /Unland/})).toBeVisible();
    await expect(needsYou.getByRole('button', {name: /GitHub/})).toBeVisible();
    await expect(manager.getByRole('group', {name: 'Fixing'})).toContainText('#1350 Trim the logs');
    await expect(manager.getByRole('group', {name: 'Merging'})).toContainText('#1300 Stop the login redirect loop');

    /* When */
    await flag.click();

    /* Then */
    await expect(manager.getByRole('complementary')).toContainText('#1340 Retry the upload');
    await expect(needsYou).toHaveAttribute('aria-selected', 'true');
});

test('Coming up lines its blocks and flags up with now, and keeps a time pin near now off the track names', async ({
    page,
    api,
}) => {
    /* Given: a head running its checks and a PR parked behind it */
    api.answer('mergeManagerPage', {...NO_FACTS, runMs: {[REPO]: 11 * 60_000}});
    await api.emit(
        'onMergeManagerChanged',
        mergeManagerState(
            [
                landedPr(1300, 'Stop the login redirect loop', 50, {kind: 'head', step: 'checks'}),
                landedPr(1340, 'Retry the upload', 40, {kind: 'needsYou', reason: {kind: 'errand-stopped'}}),
            ],
            new Map(),
        ),
    );
    await openSession(page, api, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');

    /* Then: the head block starts at now, and the flag's pole stands where the head ends */
    const comingUp = mergePage(page).getByRole('region', {name: 'Coming up'});
    const now = (await comingUp.locator('.mm-tl-axis .is-now').boundingBox())!;
    const block = (await comingUp.getByRole('button', {name: '#1300'}).boundingBox())!;
    const pole = (await comingUp.locator('.mm-tl-flag i').first().boundingBox())!;
    expect(Math.abs(block.x - now.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(pole.x + pole.width / 2 - (block.x + block.width))).toBeLessThanOrEqual(0.5);

    /* When: the head is merging, so it ends a moment from now */
    await api.emit(
        'onMergeManagerChanged',
        mergeManagerState(
            [landedPr(1300, 'Stop the login redirect loop', 50, {kind: 'head', step: 'merging'})],
            new Map(),
        ),
    );

    /* Then: its time pin starts at now, not over the track's name */
    await expect(comingUp.locator('.mm-tl-flag')).toHaveCount(0);
    const pin = (await comingUp.locator('.mm-tl-pins span').first().boundingBox())!;
    expect(pin.x).toBeGreaterThanOrEqual(now.x - 0.5);
});

test('a chip scrolls to its group, and Show unfolds Drafts and Hide folds it again', async ({page, api}) => {
    /* Given: nothing landed, two open PRs: one in review and a draft */
    api.answer('mergeManagerNotLanded', {
        pullRequests: [
            openPr(1420, 'Log slow queries', 3, {reviewDecision: 'REVIEW_REQUIRED', reviewRequested: ['bo']}),
            openPr(1410, 'Try a new header', 2, {isDraft: true}),
        ],
        fetchedAt: FIXTURE_NOW,
        failed: false,
    });
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+Shift+KeyL');
    const manager = mergePage(page);
    const drafts = manager.getByRole('group', {name: 'Drafts'});

    /* When */
    await manager
        .getByRole('navigation', {name: 'Groups'})
        .getByRole('button', {name: /Drafts/})
        .click();

    /* Then: the chip unfolds the group it goes to */
    await expect(drafts.getByRole('option', {name: /#1410 Try a new header/})).toBeInViewport();

    /* When */
    await drafts.getByRole('button', {name: 'Hide'}).click();

    /* Then */
    await expect(drafts.getByRole('option')).toHaveCount(0);

    /* When */
    await drafts.getByRole('button', {name: 'Show 1'}).click();

    /* Then */
    await expect(drafts.getByRole('option', {name: /#1410/})).toBeVisible();
    await expect(manager.getByRole('group', {name: 'Waiting on review'})).toContainText('#1420 Log slow queries');
});

test('with nothing landed the page shows the Merge manager large and how to land a pull request', async ({
    page,
    api,
}) => {
    /* Given */
    await openSession(page, api, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');

    /* Then */
    const manager = mergePage(page);
    await expect(manager.getByRole('heading', {name: 'Nothing to land yet'})).toBeVisible();
    await expect(manager.locator('.mm-empty-figure .patch-manager')).toHaveCSS('width', '180px');
});

test('the header says when the lanes and your open PRs were last read from GitHub, and when a read failed', async ({
    page,
    api,
}) => {
    /* Given: the lanes read 3½ min ago, the open PRs 1½ min ago (the page's clock is the fixture's) */
    const lanes = mergeManagerState(
        [landedPr(1300, 'Stop the login redirect loop', 50, {kind: 'head', step: 'checks'})],
        new Map(),
    );
    const readAt = FIXTURE_NOW - 3.5 * 60_000;
    api.answer('mergeManagerNotLanded', {pullRequests: [], fetchedAt: FIXTURE_NOW - 1.5 * 60_000, failed: false});
    await api.emit('onMergeManagerChanged', {
        ...lanes,
        freshness: {fetchedAt: readAt, refreshing: false, failed: false},
    });
    await openSession(page, api, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+Shift+KeyL');

    /* Then */
    const freshness = mergePage(page).getByTestId('freshness');
    await expect(freshness).toHaveText('Updated 3m ago · open PRs 1m ago');

    /* When: the next poll could not read a lane */
    await api.emit('onMergeManagerChanged', {
        ...lanes,
        freshness: {fetchedAt: readAt, refreshing: false, failed: true},
    });

    /* Then */
    await expect(freshness).toHaveText('Updated 3m ago · open PRs 1m ago · Couldn’t refresh');
});
