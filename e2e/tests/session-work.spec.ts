/**
 * The Session work page (#74): opening it from a row's meta line and with
 * Cmd+G, every way of closing it, what it shows, and the rows it cannot open
 * for.
 *
 * The fixture home has no git repositories and the suite never reaches
 * GitHub, so the page's back end is stubbed (fixtures/session-work.ts): the
 * login-fix and dashboard sessions can open, with a snapshot each. The last
 * group runs against the real service, which finds no repository and so
 * leaves every meta line as text.
 */
import { test, expect } from '../support/test';
import { openSession, sessionRow, sidebar, terminalHeader } from '../support/app';
import { fakeClaude } from '../support/fake-cli';
import { openedExternally, pushEvent, sessionWorkClosed } from '../support/main-process';
import { hasTerminal } from '../support/terminal';
import { sessionItem } from '../support/session-list';
import { LABEL, S } from '../fixtures/standard';
import { BIG_FILE_LINES, sessionWorkStub } from '../fixtures/session-work';
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

test.describe('with a repository', () => {
  test.use({ stubs: { sessionWork: sessionWorkStub() } });

  test('the meta line opens the page, and puts its session on screen first', async ({ page, home }) => {
    const trigger = workTrigger(page, LABEL.loginFix);
    await expect(trigger).toHaveAttribute('title', 'Open session work · ⌘G');
    await trigger.click();

    await fakeClaude(home, S.loginFix).launched();
    await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
    await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
    // The page has the terminal's place; the terminal is still there underneath.
    await expect(terminalHeader(page)).toBeHidden();
    expect(await hasTerminal(page, S.loginFix)).toBe(true);
  });

  test('Cmd+G opens and closes the page for the session on screen', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    await expect(workPage(page)).toBeFocused();
    await page.keyboard.press('Meta+g');
    await expectBackOnTerminal(page, home);
    await expect.poll(() => sessionWorkClosed(app)).toEqual([S.loginFix]);
  });

  test('Esc closes it', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    await page.keyboard.press('Escape');
    await expectBackOnTerminal(page, home);
    await expect.poll(() => sessionWorkClosed(app)).toEqual([S.loginFix]);
  });

  test('the Back button closes it', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    await workPage(page).getByRole('button', { name: 'Back to terminal (Esc)' }).click();
    await expectBackOnTerminal(page, home);
    await expect.poll(() => sessionWorkClosed(app)).toEqual([S.loginFix]);
  });

  test('clicking the session\'s row closes it', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    await sessionRow(page, LABEL.loginFix).click();
    await expectBackOnTerminal(page, home);
    await expect.poll(() => sessionWorkClosed(app)).toEqual([S.loginFix]);
  });

  test('switching session closes it, and opening it again starts afresh', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    await workPage(page).getByRole('button', { name: /^Done/ }).click();
    await expect(workPage(page).getByText('Log the redirect chain')).toBeVisible();

    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await expect(workPage(page)).toHaveCount(0);
    await expect(terminalHeader(page)).toContainText(LABEL.chartsDarkMode);
    await expect.poll(() => sessionWorkClosed(app)).toEqual([S.loginFix]);

    // Nothing is remembered: back on login-fix, Done is collapsed again.
    await sessionRow(page, LABEL.loginFix).click();
    await page.keyboard.press('Meta+g');
    await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
    await expect(workPage(page).getByRole('button', { name: /^Done/ })).toHaveAttribute('aria-expanded', 'false');
    await expect(workPage(page).getByText('Log the redirect chain')).toHaveCount(0);
  });

  test('shows the header, the grouped items and the selected one', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    const work = workPage(page);
    await expect(work.getByRole('link', { name: 'acme/api', exact: true })).toBeVisible();
    await expect(work.getByText('2 worktrees · 3 branches', { exact: true })).toBeVisible();
    await expect(work.getByText('updated 4s ago', { exact: true })).toBeVisible();

    const list = work.getByRole('navigation', { name: 'Work items' });
    await expect(list.getByText('In progress', { exact: true })).toBeVisible();
    await expect(list.getByText('Issues', { exact: true })).toBeVisible();
    const first = list.getByRole('button', { name: /Stop the login redirect loop/ });
    await expect(first).toContainText('#1320');
    await expect(first).toContainText('CI passing');
    await expect(first).toContainText('2 behind main');
    await expect(first).toContainText('+42−9');
    await expect(first).toHaveAttribute('aria-current', 'true');
    await expect(list.getByRole('button', { name: /Add a regression test/ })).toContainText('Draft');
    await expect(list.getByRole('button', { name: /Uncommitted changes in acme-api/ })).toContainText('2 files');
    await expect(list.getByRole('button', { name: /Uncommitted changes in acme-api/ })).toContainText('+18−4');
    const branch = list.getByRole('button', { name: /spike\/cookie-store/ });
    await expect(branch).toContainText('Not pushed');
    await expect(branch).toContainText('+61−0');
    // Done starts collapsed.
    await expect(list.getByRole('button', { name: /^Done/ })).toHaveAttribute('aria-expanded', 'false');
    await expect(list.getByText('Log the redirect chain')).toHaveCount(0);
    // A closed issue is done too: not under Issues, but a link under Done.
    await expect(list.getByText('Session cookie not marked Secure')).toHaveCount(0);
    await list.getByRole('button', { name: /^Done/ }).click();
    await expect(list.getByRole('link', { name: /Session cookie not marked Secure/ })).toContainText('Closed');
    await list.getByRole('button', { name: /^Done/ }).click();

    const detail = work.getByRole('region', { name: 'Selected work item' });
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText('Stop the login redirect loop #1320');
    await expect(detail.getByText('fix/login-loop → main', { exact: true })).toBeVisible();
    await detail.getByRole('link', { name: '#1301' }).click();
    await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/issues/1301');

    // An issue is a link out, not a selection.
    await list.getByRole('link', { name: /Users get logged out on refresh/ }).click();
    await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/issues/1290');
  });

  test('j and k move between the items while the page has the focus', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    const list = workPage(page).getByRole('navigation', { name: 'Work items' });
    const second = list.getByRole('button', { name: /Add a regression test/ });
    await page.keyboard.press('j');
    await expect(second).toHaveAttribute('aria-current', 'true');
    await expect(second).toBeFocused();
    await expect(workPage(page).getByRole('heading', { level: 2 })).toContainText('Add a regression test');
    await page.keyboard.press('k');
    await expect(list.getByRole('button', { name: /Stop the login redirect loop/ })).toHaveAttribute('aria-current', 'true');
  });

  test('the agents strip names what each working agent is doing', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    await expect(page.getByTestId('session-work-agents')).toHaveCount(0);
    await pushEvent(app, EVENT.sessionAgents, S.loginFix, [
      { id: 'a1', title: 'Audit the cookie flags' },
      { id: 'a2', title: 'Write the redirect test' },
    ]);
    const strip = page.getByTestId('session-work-agents');
    await expect(strip).toContainText('2 agents working');
    await expect(strip).toContainText('Audit the cookie flags');
    await expect(strip).toContainText('Write the redirect test');
  });

  test('nothing changed yet, and the gh banner', async ({ page }) => {
    await workTrigger(page, LABEL.chartsDarkMode).click();
    const work = workPage(page);
    await expect(work.getByText('Nothing changed yet in this session.', { exact: true })).toBeVisible();
    await expect(work.getByRole('status')).toHaveText('Run gh auth login in a terminal to see PR status and CI.');
  });

  test('a remote row is not a button, and says why', async ({ page }) => {
    const row = sessionItem(page, S.remoteApi);
    await expect(row.getByRole('button', { name: /^Open session work/ })).toHaveCount(0);
    await expect(row.locator('[title="Session work isn\'t available for remote sessions yet"]')).toHaveCount(1);
  });

  test('a row outside a repository is not a button, and Cmd+G does nothing for it', async ({ page, home }) => {
    const row = sessionItem(page, S.worktreeTry);
    await expect(row.locator('[title="Not a git repository"]')).toHaveCount(1);
    await expect(row.getByRole('button', { name: /^Open session work/ })).toHaveCount(0);

    await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    await page.keyboard.press('Meta+g');
    // Cmd+G asks main again before giving up; wait for that round trip.
    await page.evaluate(id => window.api.canOpenSessionWork(id), S.worktreeTry);
    await expect(workPage(page)).toHaveCount(0);
    await expect(terminalHeader(page)).toBeVisible();
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

  test('loads for the selected item, one card per file, unified by default', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    const diff = diffOf(page);
    await expect(diff).toHaveAttribute('aria-busy', 'false');
    await expect(diff.getByTestId('session-work-file')).toHaveCount(4);
    await expect(diff.getByText('4 files changed', { exact: true })).toBeVisible();
    await expect(diff.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true');
    await expect(diff.getByText('Branch not checked out locally.')).toHaveCount(0);

    const session = fileCard(page, 'src/session.ts');
    await expect(session).toContainText('+3−2');
    await expect(session.locator('.sw-dl[data-kind="hunk"]')).toHaveText('@@ -10,6 +10,7 @@ export function refresh(session: Session) {');
    await expect(session.locator('.sw-dl[data-kind="delete"]')).toHaveCount(2);
    await expect(session.locator('.sw-dl[data-kind="add"]')).toHaveCount(3);
    // The new file's line numbers on additions, the old file's on deletions.
    await expect(session.locator('.sw-dl[data-kind="add"]').first().locator('.sw-dl-num')).toHaveText(['', '11']);
    await expect(session.locator('.sw-dl[data-kind="delete"]').first().locator('.sw-dl-num')).toHaveText(['11', '']);
    await expect(fileCard(page, 'src/fixtures/big.ts')).toContainText('New');
  });

  test('u and the toggle switch between unified and split', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    const diff = diffOf(page);
    const session = fileCard(page, 'src/session.ts');
    await expect(session.locator('.sw-dl[data-kind="add"]')).toHaveCount(3);

    await page.keyboard.press('u');
    await expect(diff.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await expect(session.locator('.sw-lines')).toHaveClass(/\bis-split\b/);
    // Two deletions beside the first two of three additions; the third has a blank cell beside it.
    const pairs = session.locator('.sw-dl.is-pair');
    await expect(pairs.nth(1)).toContainText('return redirect("/login");');
    await expect(pairs.nth(1)).toContainText('if (!token) return null;');
    await expect(pairs.nth(2)).toContainText('return renew(token);');
    await expect(pairs.nth(2)).toContainText('const next = renew(token);');
    await expect(pairs.nth(3).locator('[data-side="left"][data-kind="empty"]')).toHaveCount(1);
    await expect(pairs.nth(3)).toContainText('return next ?? null;');

    await diff.getByRole('button', { name: 'Unified' }).click();
    await expect(session.locator('.sw-lines')).toHaveClass(/\bis-unified\b/);
    await page.keyboard.press('u');
    await expect(session.locator('.sw-lines')).toHaveClass(/\bis-split\b/);
  });

  test('a lock file starts collapsed with its reason until Show diff; a binary file is one row', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    const lock = fileCard(page, 'package-lock.json');
    await expect(lock).toContainText('Lock file');
    await expect(lock.locator('.sw-dl')).toHaveCount(0);
    await lock.getByRole('button', { name: 'Show diff' }).click();
    await expect(lock.locator('.sw-dl[data-kind="add"]')).toHaveText(/"version": "1\.0\.1",/);
    await expect(lock.getByRole('button', { name: 'Show diff' })).toHaveCount(0);

    const logo = fileCard(page, 'assets/logo.png');
    await expect(logo.locator('.sw-file-row')).toHaveText('Binary file changed');
    await expect(logo.locator('.sw-dl')).toHaveCount(0);
  });

  test('a 5,000-line file draws nothing until opened, then every line without holding up the keyboard', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    const big = fileCard(page, 'src/fixtures/big.ts');
    await expect(big).toContainText(`Large diff · ${BIG_FILE_LINES.toLocaleString('en-US')} lines changed`);
    await expect(big.locator('.sw-dl')).toHaveCount(0);

    await big.getByRole('button', { name: 'Show diff' }).click();
    // The page still answers while the file fills in.
    await page.keyboard.press('u');
    await expect(diffOf(page).getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    const lines = big.locator('.sw-lines');
    await expect(lines).toHaveAttribute('data-shown', String(BIG_FILE_LINES + 1));
    await expect(big.locator('.sw-dl.is-pair')).toHaveCount(BIG_FILE_LINES);
    await expect(big.locator('.sw-dl.is-pair').last()).toContainText(`export const line${BIG_FILE_LINES} = ${BIG_FILE_LINES};`);
  });

  test('n and p move between the files', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    const cards = diffOf(page).getByTestId('session-work-file');
    await expect(cards).toHaveCount(4);

    await page.keyboard.press('n');
    await expect(cards.nth(0)).toHaveClass(/\bis-focused\b/);
    await expect(cards.nth(0).locator('.sw-file-head')).toBeFocused();
    await page.keyboard.press('n');
    await expect(cards.nth(1)).toHaveClass(/\bis-focused\b/);
    await expect(cards.nth(0)).not.toHaveClass(/\bis-focused\b/);
    await page.keyboard.press('n');
    await page.keyboard.press('p');
    await expect(cards.nth(1)).toHaveClass(/\bis-focused\b/);
    await expect(cards.nth(1).locator('.sw-file-head')).toBeFocused();
  });

  test('a PR whose diff came from GitHub says its branch is not checked out', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    const list = workPage(page).getByRole('navigation', { name: 'Work items' });
    await list.getByRole('button', { name: /^Done/ }).click();
    await list.getByRole('button', { name: /Log the redirect chain/ }).click();

    const diff = diffOf(page);
    await expect(diff.getByRole('note')).toHaveText('Branch not checked out locally.');
    await expect(fileCard(page, 'src/log.ts').locator('.sw-dl[data-kind="add"]')).toHaveText(/export const chain/);
  });
});

test.describe('while a diff is on its way', () => {
  test.use({ stubs: { sessionWork: { ...sessionWorkStub(), diffs: { ['pr:https://github.com/acme/api/pull/1320']: 'never' } } } });

  test('the item\'s header stays up over a skeleton', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    const detail = workPage(page).getByRole('region', { name: 'Selected work item' });
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText('Stop the login redirect loop #1320');
    await expect(detail.getByTestId('session-work-diff')).toHaveAttribute('aria-busy', 'true');
    await expect(detail.locator('.sw-diff-skeleton')).toBeVisible();
  });
});

test.describe('while the snapshot is on its way', () => {
  test.use({ stubs: { sessionWork: { canOpen: [S.loginFix], snapshots: {} } } });

  test('the header shows at once over a skeleton list', async ({ page }) => {
    await workTrigger(page, LABEL.loginFix).click();
    await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
    await expect(workPage(page).getByRole('navigation', { name: 'Work items' })).toHaveAttribute('aria-busy', 'true');
  });
});

test.describe('against the real service', () => {
  test('a session outside a git repository has a plain meta line', async ({ page }) => {
    const row = sessionItem(page, S.loginFix);
    await expect(row.locator('[title="Not a git repository"]')).toHaveCount(1);
    await expect(row.getByRole('button', { name: /^Open session work/ })).toHaveCount(0);
  });
});
