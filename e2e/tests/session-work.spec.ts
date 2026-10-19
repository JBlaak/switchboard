/**
 * The Session work page (#74) wired into the real app: opening it from a
 * row's meta line and with Cmd+G, every way of closing it, the keys it takes,
 * what it hands to main, and the diff.
 *
 * What the page shows for a given snapshot (groups, pills, labels, cards,
 * buttons) is decided by the session-work slice and `describe`, unit tested in
 * test/session-work-*.test.ts; these tests only prove the wiring.
 *
 * The fixture home has no git repositories and the suite never reaches
 * GitHub, so the page's back end is stubbed (fixtures/session-work.ts): the
 * login-fix and dashboard sessions can open, with a snapshot each. The last
 * test runs against the real service, which finds no repository and so
 * leaves every meta line as text.
 */
import { test, expect } from '../support/test';
import { openSession, sessionRow, sidebar, terminalHeader } from '../support/app';
import { fakeClaude } from '../support/fake-cli';
import {
  openedExternally, pushEvent, sessionWorkActions, sessionWorkCancels, sessionWorkClosed,
} from '../support/main-process';
import { hasTerminal } from '../support/terminal';
import { sessionItem } from '../support/session-list';
import { LABEL, S } from '../fixtures/standard';
import { BIG_FILE_LINES, FIRST_PR_ID, loginFixWorkWith, sessionWorkStub } from '../fixtures/session-work';
import { EVENT } from '../../src/ipc/channels';
import type { Page } from '@playwright/test';

/** The meta line of a row, as the button that opens its page. */
function workTrigger(page: Page, label: string) {
  return sidebar(page).getByRole('button', { name: 'Open session work for ' + label, exact: true });
}

function workPage(page: Page) {
  return page.getByRole('region', { name: /^Session work for / });
}

function workHeading(page: Page) {
  return workPage(page).getByRole('heading', { level: 1 });
}

/** The terminal's keyboard target: xterm's hidden textarea. */
function terminalInput(page: Page) {
  return page.getByRole('textbox', { name: 'Terminal input' });
}

/** Open the login-fix session and its page with Cmd+G, from the terminal. */
async function openLoginFixWork(page: Page, home: Parameters<typeof openSession>[1]): Promise<void> {
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await expect(terminalInput(page)).toBeFocused();
  await page.keyboard.press('Meta+g');
  await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
}

/** The page is gone, the terminal is back with the focus, and its process never restarted. */
async function expectBackOnTerminal(page: Page, home: Parameters<typeof openSession>[1]): Promise<void> {
  await expect(workPage(page)).toHaveCount(0);
  await expect(terminalHeader(page)).toBeVisible();
  await expect(terminalInput(page)).toBeFocused();
  expect(fakeClaude(home, S.loginFix).launches()).toHaveLength(1);
  expect(await hasTerminal(page, S.loginFix)).toBe(true);
}

/** Open the page again with Cmd+G, from the terminal it closed back to. */
async function reopen(page: Page): Promise<void> {
  await page.keyboard.press('Meta+g');
  await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
}

test.describe('with a repository', () => {
  test.use({ stubs: { sessionWork: sessionWorkStub() } });

  test('the meta line opens the page, and puts its session on screen first', async ({ page, home }) => {
    /* Given */
    const trigger = workTrigger(page, LABEL.loginFix);
    await expect(trigger).toHaveAttribute('title', 'Open session work · ⌘G');

    /* When */
    await trigger.click();

    /* Then */
    await fakeClaude(home, S.loginFix).launched();
    await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
    await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
    // The page has the terminal's place; the terminal is still there underneath.
    await expect(terminalHeader(page)).toBeHidden();
    expect(await hasTerminal(page, S.loginFix)).toBe(true);
  });

  test('Cmd+G opens the page for the session on screen; Cmd+G, Esc, Back, its row and another session close it', async ({ page, home, app }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(terminalInput(page)).toBeFocused();

    /* When */
    await page.keyboard.press('Meta+g');

    /* Then */
    await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
    await expect(workPage(page)).toBeFocused();

    /* When */
    await page.keyboard.press('Meta+g');

    /* Then */
    await expectBackOnTerminal(page, home);
    await expect.poll(() => sessionWorkClosed(app)).toHaveLength(1);

    /* When */
    await reopen(page);
    await page.keyboard.press('Escape');

    /* Then */
    await expectBackOnTerminal(page, home);
    await expect.poll(() => sessionWorkClosed(app)).toHaveLength(2);

    /* When */
    await reopen(page);
    await workPage(page).getByRole('button', { name: 'Back to terminal (Esc)' }).click();

    /* Then */
    await expectBackOnTerminal(page, home);
    await expect.poll(() => sessionWorkClosed(app)).toHaveLength(3);

    /* When */
    await reopen(page);
    await sessionRow(page, LABEL.loginFix).click();

    /* Then */
    await expectBackOnTerminal(page, home);
    await expect.poll(() => sessionWorkClosed(app)).toHaveLength(4);

    /* When */
    await reopen(page);
    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);

    /* Then */
    await expect(workPage(page)).toHaveCount(0);
    await expect(terminalHeader(page)).toContainText(LABEL.chartsDarkMode);
    await expect.poll(() => sessionWorkClosed(app)).toEqual(Array(5).fill(S.loginFix));
  });

  test('the page shows its snapshot, links out, takes j and k, and names the working agents', async ({ page, home, app }) => {
    /* Given */
    await openLoginFixWork(page, home);
    const work = workPage(page);
    const list = work.getByRole('navigation', { name: 'Work items' });
    const detail = work.getByRole('region', { name: 'Selected work item' });

    /* Then */
    await expect(work.getByRole('link', { name: 'acme/api', exact: true })).toBeVisible();
    await expect(work.getByText('2 worktrees · 3 branches', { exact: true })).toBeVisible();
    await expect(list.getByText('In progress', { exact: true })).toBeVisible();
    await expect(list.getByText('Issues', { exact: true })).toBeVisible();
    const first = list.getByRole('button', { name: /Stop the login redirect loop/ });
    await expect(first).toContainText('#1320');
    await expect(first).toHaveAttribute('aria-current', 'true');
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText('Stop the login redirect loop #1320');
    await expect(page.getByTestId('session-work-agents')).toHaveCount(0);

    /* When */
    await detail.getByRole('link', { name: '#1301' }).click();

    /* Then */
    await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/issues/1301');

    /* When */
    // An issue is a link out, not a selection.
    await list.getByRole('link', { name: /Users get logged out on refresh/ }).click();

    /* Then */
    await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/issues/1290');

    /* When */
    await work.focus();
    await page.keyboard.press('j');

    /* Then */
    const second = list.getByRole('button', { name: /Add a regression test/ });
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect(second).toBeFocused();
    await expect(detail.getByRole('heading', { level: 2 })).toContainText('Add a regression test');

    /* When */
    await page.keyboard.press('k');

    /* Then */
    await expect(first).toHaveAttribute('aria-current', 'true');

    /* When */
    await pushEvent(app, EVENT.sessionAgents, S.loginFix, [
      { id: 'a1', title: 'Audit the cookie flags' },
      { id: 'a2', title: 'Write the redirect test' },
    ]);

    /* Then */
    const strip = page.getByTestId('session-work-agents');
    await expect(strip).toContainText('2 agents working');
    await expect(strip).toContainText('Audit the cookie flags');
    await expect(strip).toContainText('Write the redirect test');
  });
});

test.describe('actions', () => {
  test.use({ stubs: { sessionWork: sessionWorkStub() } });

  function actions(page: Page) {
    return workPage(page).getByRole('group', { name: 'Actions' });
  }

  async function select(page: Page, name: RegExp): Promise<void> {
    await workPage(page).getByRole('navigation', { name: 'Work items' }).getByRole('button', { name }).click();
  }

  test('a button hands its item to main for the session on screen; the card cancels it, or goes to the terminal', async ({ page, home, app }) => {
    /* Given */
    await openLoginFixWork(page, home);

    /* When */
    await actions(page).getByRole('button', { name: 'Ship it' }).click();

    /* Then */
    await expect.poll(() => sessionWorkActions(app)).toEqual([{ sessionId: S.loginFix, itemId: FIRST_PR_ID, action: 'ship' }]);

    /* When */
    await select(page, /spike\/cookie-store/);
    await actions(page).getByRole('button', { name: 'Open a new PR' }).click();

    /* Then */
    await expect.poll(async () => (await sessionWorkActions(app)).map(request => request.action)).toEqual(['ship', 'open-pr']);
    await expect(actions(page).getByRole('button', { name: 'Open on GitHub' })).toHaveCount(0);

    /* When */
    await select(page, /Stop the login redirect loop/);
    await actions(page).getByRole('button', { name: 'Open on GitHub' }).click();

    /* Then */
    await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/pull/1320');

    /* When */
    await pushEvent(app, EVENT.sessionWorkSnapshot, loginFixWorkWith(
      { id: 'act-7', action: 'ship', phase: 'queued', origin: 'manual', queuedAt: new Date().toISOString() },
      { queued: 2 },
    ));

    /* Then */
    const card = page.getByTestId('session-work-activity');
    await expect(card).toContainText('Queued: ship #1320');

    /* When */
    await card.getByRole('button', { name: 'Cancel' }).click();

    /* Then */
    await expect.poll(() => sessionWorkCancels(app)).toEqual(['act-7']);

    /* When */
    const now = new Date().toISOString();
    await pushEvent(app, EVENT.sessionWorkSnapshot, loginFixWorkWith(
      { id: 'act-1', action: 'ship', phase: 'sent', origin: 'manual', queuedAt: now, sentAt: now },
    ));
    await card.getByRole('button', { name: 'View in terminal' }).click();

    /* Then */
    await expectBackOnTerminal(page, home);
  });
});

test.describe('the diff', () => {
  test.use({ stubs: { sessionWork: sessionWorkStub() } });

  function diffOf(page: Page) {
    return workPage(page).getByTestId('session-work-diff');
  }

  function fileCard(page: Page, path: string) {
    return diffOf(page).getByRole('region', { name: path, exact: true });
  }

  test('loads for the selected item; u, the toggle, n and p work it; a 5,000-line file fills in without holding up the keyboard', async ({ page, home }) => {
    /* Given */
    await openLoginFixWork(page, home);
    const diff = diffOf(page);
    const session = fileCard(page, 'src/session.ts');
    const cards = diff.getByTestId('session-work-file');

    /* Then */
    await expect(diff).toHaveAttribute('aria-busy', 'false');
    await expect(cards).toHaveCount(4);
    await expect(diff.getByText('4 files changed', { exact: true })).toBeVisible();
    await expect(diff.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true');
    await expect(session.locator('.sw-dl[data-kind="delete"]')).toHaveCount(2);
    await expect(session.locator('.sw-dl[data-kind="add"]')).toHaveCount(3);

    /* When */
    await page.keyboard.press('u');

    /* Then */
    await expect(diff.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await expect(session.locator('.sw-lines')).toHaveClass(/\bis-split\b/);

    /* When */
    await diff.getByRole('button', { name: 'Unified' }).click();

    /* Then */
    await expect(session.locator('.sw-lines')).toHaveClass(/\bis-unified\b/);

    /* When */
    await workPage(page).focus();
    await page.keyboard.press('n');

    /* Then */
    await expect(cards.nth(0)).toHaveClass(/\bis-focused\b/);
    await expect(cards.nth(0).locator('.sw-file-head')).toBeFocused();

    /* When */
    await page.keyboard.press('n');
    await page.keyboard.press('n');
    await page.keyboard.press('p');

    /* Then */
    await expect(cards.nth(1)).toHaveClass(/\bis-focused\b/);
    await expect(cards.nth(0)).not.toHaveClass(/\bis-focused\b/);
    await expect(cards.nth(1).locator('.sw-file-head')).toBeFocused();
    const big = fileCard(page, 'src/fixtures/big.ts');
    await expect(big).toContainText(`Large diff · ${BIG_FILE_LINES.toLocaleString('en-US')} lines changed`);
    await expect(big.locator('.sw-dl')).toHaveCount(0);

    /* When */
    await big.getByRole('button', { name: 'Show diff' }).click();
    // The page still answers while the file fills in.
    await page.keyboard.press('u');

    /* Then */
    await expect(diff.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await expect(big.locator('.sw-lines')).toHaveAttribute('data-shown', String(BIG_FILE_LINES + 1));
    await expect(big.locator('.sw-dl.is-pair')).toHaveCount(BIG_FILE_LINES);
    await expect(big.locator('.sw-dl.is-pair').last()).toContainText(`export const line${BIG_FILE_LINES} = ${BIG_FILE_LINES};`);
  });
});

test.describe('against the real service', () => {
  test('a session outside a git repository has a plain meta line, and Cmd+G does nothing for it', async ({ page, home }) => {
    /* Given */
    const row = sessionItem(page, S.loginFix);
    await expect(row.locator('[title="Not a git repository"]')).toHaveCount(1);
    await expect(row.getByRole('button', { name: /^Open session work/ })).toHaveCount(0);
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await page.keyboard.press('Meta+g');
    // Cmd+G asks main again before giving up; wait for that round trip.
    await page.evaluate(id => window.api.canOpenSessionWork(id), S.loginFix);

    /* Then */
    await expect(workPage(page)).toHaveCount(0);
    await expect(terminalHeader(page)).toBeVisible();
  });
});
