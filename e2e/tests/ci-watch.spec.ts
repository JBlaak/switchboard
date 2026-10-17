/**
 * The CI watch (#78), as the UI shows it: the PR chips' status dots and the
 * `+N` chip's tooltip, the Checks panel with a failing check's log, the
 * activity card while Claude fixes CI on its own and once it gave up, and the
 * row's needs-attention marker.
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
import type { Activity } from '../../src/domain/session-work/model';
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

test('each PR chip gets its dot, and "+N" the worst of the PRs it hides, named in its tooltip', async ({ page, app }) => {
  const row = sessionItem(page, S.loginFix);
  // Nothing known yet: no dots.
  await expect(row.locator('.session-pr-dot')).toHaveCount(0);

  await pushEvent(app, EVENT.prStatusChanged, prStatus([
    { number: 1309, dot: 'red' },
    { number: 1312, dot: 'amber' },
    { number: 1320, dot: 'green' },
  ], true));

  const chip = (text: string) => row.locator('.session-pr, .session-pr-more').filter({ hasText: text });
  await expect(chip('#1320').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'green');
  await expect(chip('#1320')).toHaveAttribute('title', 'acme/api#1320 · passing');
  await expect(chip('#1312').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'amber');
  await expect(chip('+1').locator('.session-pr-dot')).toHaveAttribute('data-dot', 'red');
  await expect(chip('+1')).toHaveAttribute('title', 'acme/api#1309 · failing');

  // The session stopped: what the watch last said would go stale.
  await pushEvent(app, EVENT.prStatusChanged, prStatus([]));
  await expect(row.locator('.session-pr-dot')).toHaveCount(0);
});

test('auto-fix giving up marks the PR red and raises needs-attention on the row', async ({ page, app }) => {
  const row = sessionItem(page, S.loginFix);
  await expect(row).not.toHaveClass(/\bneeds-attention\b/);
  // What main sends when auto-fix gives up on a session that is not on screen.
  await pushEvent(app, EVENT.prStatusChanged, prStatus([{ number: 1320, dot: 'red' }], true));
  await pushEvent(app, EVENT.sessionNeedsAttention, S.loginFix);
  await expect(row).toHaveClass(/\bneeds-attention\b/);
  await expect(row.locator('.session-pr', { hasText: '#1320' }).locator('.session-pr-dot')).toHaveAttribute('data-dot', 'red');
});

test('the Checks panel lists each check, with the failing one\'s log', async ({ page, home, app }) => {
  await openLoginFixWork(page, home);
  await pushEvent(app, EVENT.sessionWorkSnapshot, loginFixWorkWith(null, { facts: FAILING }));
  const checks = workPage(page).getByRole('region', { name: 'Checks' });
  await expect(checks.getByRole('listitem')).toHaveCount(3);
  await expect(checks.getByRole('listitem').filter({ hasText: 'lint' })).toContainText('Passing');
  await expect(checks.getByRole('listitem').filter({ hasText: 'e2e' })).toContainText('Running');
  const failing = checks.getByRole('listitem').filter({ hasText: 'test' });
  await expect(failing).toContainText('Failing');
  await expect(failing.getByLabel('Log of test')).toHaveText(LOG);
});

test('Claude fixing CI on its own: amber, with the attempt', async ({ page, home, app }) => {
  await openLoginFixWork(page, home);
  const activity: Activity = {
    id: 'auto-1', action: 'fix-ci', phase: 'sent', origin: 'auto', attempt: 1, checkName: 'test',
    queuedAt: new Date().toISOString(), sentAt: new Date().toISOString(),
  };
  await pushEvent(app, EVENT.sessionWorkSnapshot, loginFixWorkWith(activity, { facts: FAILING }));
  const card = page.getByTestId('session-work-activity');
  await expect(card).toHaveClass(/\bis-amber\b/);
  await expect(card).toContainText('Claude is fixing CI · attempt 1 of 2');
  await expect(card).toContainText('test failed');
  await expect(card.getByRole('button', { name: 'View in terminal' })).toBeVisible();
});

test('auto-fix gave up: red, listing each attempt and what Claude pushed', async ({ page, home, app }) => {
  await openLoginFixWork(page, home);
  const activity: Activity = {
    id: 'gave-1', action: 'fix-ci', phase: 'gave-up', origin: 'auto', checkName: 'test',
    attempts: [
      { attempt: 1, failedOn: 'aaaaaaa111', pushed: 'bbbbbbb222' },
      { attempt: 2, failedOn: 'bbbbbbb222', pushed: 'c0ffee1234' },
    ],
    queuedAt: new Date().toISOString(),
  };
  await pushEvent(app, EVENT.sessionWorkSnapshot, loginFixWorkWith(activity, { facts: FAILING }));
  const card = page.getByTestId('session-work-activity');
  await expect(card).toHaveClass(/\bis-red\b/);
  await expect(card).toContainText('Still failing after 2 automatic fixes');
  const attempts = card.getByRole('list', { name: 'Attempts' }).getByRole('listitem');
  await expect(attempts).toHaveText([
    'Attempt 1 · failed on aaaaaaa · pushed bbbbbbb',
    'Attempt 2 · failed on bbbbbbb · pushed c0ffee1',
  ]);
  // Fix CI stays available: a manual one is always allowed.
  await expect(workPage(page).getByRole('group', { name: 'Actions' }).getByRole('button', { name: /Fix CI/ })).toBeVisible();
});
