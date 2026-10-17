/**
 * The CI watch (#78), as the UI shows it: the PR chips' status dots and the
 * `+N` chip's tooltip, the row's needs-attention marker, and the Checks panel
 * with a failing check's log.
 *
 * Which dot a chip takes and what the auto-fix activity card says are unit
 * tested (test/ci-status-slice.test.ts, test/session-work-rules.test.ts);
 * these tests prove main's pushes and the log request reach the screen.
 *
 * The suite never reaches GitHub, so the watch itself is off here (it polls
 * the user's own `gh`); each test pushes what main would push instead —
 * `pr-status:changed` for the dots, a snapshot for the page — and the Checks
 * panel's log comes from the Session work stub.
 */
import { test, expect } from '../support/test';
import { openSession } from '../support/app';
import { pushEvent } from '../support/main-process';
import { sessionItem } from '../support/session-list';
import { LABEL, S } from '../fixtures/standard';
import { loginFixWorkWith, sessionWorkStub } from '../fixtures/session-work';
import { EVENT } from '../../src/ipc/channels';
import type { PullRequestStatusChange } from '../../src/domain/session-work/status';
import type { Page } from '@playwright/test';

const RUN = 'https://github.com/acme/api/actions/runs/11/job/22';
const LOG = 'FAIL src/session.test.ts\n  ✕ refresh does not loop (12 ms)\nExpected: null\nReceived: "/login"';

/** The failing checks the first PR has in these tests. */
const FAILING = {
  headSha: 'c0ffee1234',
  checks: [
    { name: 'lint', state: 'passing' as const },
    { name: 'test', state: 'failing' as const, url: RUN },
    { name: 'e2e', state: 'pending' as const },
  ],
};

function workPage(page: Page) {
  return page.getByRole('region', { name: /^Session work for / });
}

async function openLoginFixWork(page: Page, home: Parameters<typeof openSession>[1]): Promise<void> {
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await page.keyboard.press('Meta+g');
  await expect(workPage(page).getByRole('heading', { level: 1 })).toHaveText('Work · ' + LABEL.loginFix);
}

function prStatus(prs: PullRequestStatusChange['prs'], needsYou = false): PullRequestStatusChange {
  return { sessionId: S.loginFix, prs, needsYou };
}

test.use({ stubs: { sessionWork: { ...sessionWorkStub(), checkLogs: { [RUN]: LOG } } } });

test('the watch\'s pushes reach the row: a dot per PR chip, the worst on "+N" named in its tooltip, and needs-attention', async ({ page, app }) => {
  /* Given */
  const row = sessionItem(page, S.loginFix);
  const chip = (text: string) => row.locator('.session-pr, .session-pr-more').filter({ hasText: text });
  // Nothing known yet: no dots.
  await expect(row.locator('.session-pr-dot')).toHaveCount(0);
  await expect(row).not.toHaveClass(/\bneeds-attention\b/);

  /* When */
  await pushEvent(app, EVENT.prStatusChanged, prStatus([
    { number: 1309, dot: 'red' },
    { number: 1312, dot: 'amber' },
    { number: 1320, dot: 'green' },
  ], true));

  /* Then */
  await expect(chip('#1320').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'green');
  await expect(chip('#1320')).toHaveAttribute('title', 'acme/api#1320 · passing');
  await expect(chip('#1312').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'amber');
  await expect(chip('+1').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'red');
  await expect(chip('+1')).toHaveAttribute('title', 'acme/api#1309 · failing');

  /* When */
  // The session stopped: what the watch last said would go stale.
  await pushEvent(app, EVENT.prStatusChanged, prStatus([]));

  /* Then */
  await expect(row.locator('.session-pr-dot')).toHaveCount(0);

  /* When */
  // What main sends when auto-fix gives up on a session that is not on screen.
  await pushEvent(app, EVENT.prStatusChanged, prStatus([{ number: 1320, dot: 'red' }], true));
  await pushEvent(app, EVENT.sessionNeedsAttention, S.loginFix);

  /* Then */
  await expect(row).toHaveClass(/\bneeds-attention\b/);
  await expect(chip('#1320').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'red');

  /* When */
  await pushEvent(app, EVENT.prStatusChanged, prStatus([{ number: 1320, dot: 'merged' }]));

  /* Then */
  // A merged PR swaps its dot for a check.
  await expect(chip('#1320').locator('.session-pr-dot')).toHaveCount(0);
  await expect(chip('#1320').locator('.session-pr-merged svg')).toBeVisible();
  await expect(chip('#1320')).toHaveAttribute('title', 'acme/api#1320 · merged');
});

test('the Checks panel lists each check, with the failing one\'s log', async ({ page, home, app }) => {
  /* Given */
  await openLoginFixWork(page, home);

  /* When */
  await pushEvent(app, EVENT.sessionWorkSnapshot, loginFixWorkWith(null, { facts: FAILING }));

  /* Then */
  const checks = workPage(page).getByRole('region', { name: 'Checks' });
  await expect(checks.getByRole('listitem')).toHaveCount(3);
  await expect(checks.getByRole('listitem').filter({ hasText: 'lint' })).toContainText('Passing');
  await expect(checks.getByRole('listitem').filter({ hasText: 'e2e' })).toContainText('Running');
  const failing = checks.getByRole('listitem').filter({ hasText: 'test' });
  await expect(failing).toContainText('Failing');
  await expect(failing.getByLabel('Log of test')).toHaveText(LOG);
});
