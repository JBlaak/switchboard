/**
 * The CI watch (#78), as the UI shows it: the PR chips' status dots and the
 * `+N` chip's tooltip, the row's needs-attention marker, and the Checks panel
 * with a failing check's log.
 *
 * Which dot a chip takes is unit tested (test/ci-status-slice.test.ts,
 * test/session-work-rules.test.ts);
 * these tests prove main's pushes and the log request reach the screen.
 *
 * Each test pushes what main's watch would push — `onPrStatusChanged` for the
 * dots, a snapshot for the page — and the Checks panel's log comes from the
 * Session work stub.
 */
import {test, expect} from '../support/test';
import {openLoginFixWork, sessionWorkAnswers, workPage} from '../support/session-work';
import {sessionItem} from '../../e2e/support/session-list';
import {S} from '../../e2e/fixtures/standard';
import {loginFixWorkWith, sessionWorkStub} from '../../e2e/fixtures/session-work';
import type {PullRequestStatusChange} from '../../src/domain/session-work/status';

const RUN = 'https://github.com/acme/api/actions/runs/11/job/22';
const LOG = 'FAIL src/session.test.ts\n  ✕ refresh does not loop (12 ms)\nExpected: null\nReceived: "/login"';

/** The failing checks the first PR has in these tests. */
const FAILING = {
    headSha: 'c0ffee1234',
    checks: [
        {name: 'lint', state: 'passing' as const},
        {name: 'test', state: 'failing' as const, url: RUN},
        {name: 'e2e', state: 'pending' as const},
    ],
};

function prStatus(prs: PullRequestStatusChange['prs'], needsYou = false): PullRequestStatusChange {
    return {sessionId: S.loginFix, prs, needsYou};
}

test.use({answers: sessionWorkAnswers({...sessionWorkStub(), checkLogs: {[RUN]: LOG}})});

test('the watch\'s pushes reach the row: a dot per PR chip, the worst on "+N" named in its tooltip, and needs-attention', async ({
    page,
    api,
}) => {
    /* Given */
    const row = sessionItem(page, S.loginFix);
    const chip = (text: string) => row.locator('.session-pr, .session-pr-more').filter({hasText: text});
    // Nothing known yet: no dots.
    await expect(row.locator('.session-pr-dot')).toHaveCount(0);
    await expect(row).not.toHaveClass(/\bneeds-attention\b/);

    /* When */
    await api.emit(
        'onPrStatusChanged',
        prStatus(
            [
                {number: 1309, dot: 'red'},
                {number: 1312, dot: 'amber'},
                {number: 1320, dot: 'green'},
            ],
            true,
        ),
    );

    /* Then */
    await expect(chip('#1320').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'green');
    await expect(chip('#1320')).toHaveAttribute('title', 'acme/api#1320 · passing');
    await expect(chip('#1312').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'amber');
    await expect(chip('+1').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'red');
    await expect(chip('+1')).toHaveAttribute('title', 'acme/api#1309 · failing');

    /* When */
    // The session stopped: what the watch last said would go stale.
    await api.emit('onPrStatusChanged', prStatus([]));

    /* Then */
    await expect(row.locator('.session-pr-dot')).toHaveCount(0);

    /* When */
    // What main sends when a PR of a session that is not on screen waits on you.
    await api.emit('onPrStatusChanged', prStatus([{number: 1320, dot: 'red'}], true));
    await api.emit('onSessionNeedsAttention', S.loginFix);

    /* Then */
    await expect(row).toHaveClass(/\bneeds-attention\b/);
    await expect(chip('#1320').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'red');

    /* When */
    await api.emit('onPrStatusChanged', prStatus([{number: 1320, dot: 'merged'}]));

    /* Then */
    // A merged PR swaps its dot for a check.
    await expect(chip('#1320').locator('.session-pr-dot')).toHaveCount(0);
    await expect(chip('#1320').locator('.session-pr-merged svg')).toBeVisible();
    await expect(chip('#1320')).toHaveAttribute('title', 'acme/api#1320 · merged');
});

test("the Checks panel lists each check, with the failing one's log", async ({page, api}) => {
    /* Given */
    await openLoginFixWork(page, api);

    /* When */
    await api.emit('onSessionWorkSnapshot', loginFixWorkWith(FAILING));

    /* Then */
    const checks = workPage(page).getByRole('region', {name: 'Checks'});
    await expect(checks.getByRole('listitem')).toHaveCount(3);
    await expect(checks.getByRole('listitem').filter({hasText: 'lint'})).toContainText('Passing');
    await expect(checks.getByRole('listitem').filter({hasText: 'e2e'})).toContainText('Running');
    const failing = checks.getByRole('listitem').filter({hasText: 'test'});
    await expect(failing).toContainText('Failing');
    await expect(failing.getByLabel('Log of test')).toHaveText(LOG);
});
