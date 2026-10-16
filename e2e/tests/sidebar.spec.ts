/**
 * The session list: tiers, truncation, slug groups, filters and search, drawn
 * from the standard fixture.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  expectScreen, openSession, rowButton, searchBox, sessionRow, sidebar, sidebarFilter,
} from '../support/app';
import { openedExternally } from '../support/main-process';
import { LABEL, S } from '../fixtures/standard';

test.describe('smoke', () => {
  test('lists pinned first, then recent, and folds old sessions away', async ({ page }) => {
    await expect(sidebar(page).getByText('Pinned', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('Recent', { exact: true })).toBeVisible();
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeHidden();
    await expect(sessionRow(page, LABEL.graphqlSpike)).toHaveCount(0);

    await sidebar(page).getByText('+ 3 older', { exact: true }).click();
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeVisible();
  });

  test('shows a renamed session by its name and a worktree by its branch', async ({ page }) => {
    await expect(sessionRow(page, LABEL.chartsDarkMode)).toBeVisible();
    await expect(sidebar(page).getByText('Development/old-parser ⎇ streaming', { exact: true })).toBeVisible();
    // A worktree whose checkout still exists lists under its repository.
    await expect(sessionRow(page, LABEL.worktreeTry)).toBeVisible();
    await expect(sidebar(page).getByText('Development/acme-api ⎇ session-cookie')).toHaveCount(0);
  });

  test('folds a slug group and expands it on click', async ({ page }) => {
    await expect(sidebar(page).getByText('3 sessions', { exact: true })).toBeVisible();
    await expect(sessionRow(page, 'Implement the plan: extract the invoice model')).toBeHidden();
    await sessionRow(page, LABEL.billingGroup).first().click();
    await expect(sessionRow(page, 'Implement the plan: extract the invoice model')).toBeVisible();
  });

  test('opens a pull request chip in the browser', async ({ page, app }) => {
    await expect(sidebar(page).getByText('+1', { exact: true })).toBeVisible();
    await sidebar(page).getByText('#1320', { exact: true }).click();
    await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/pull/1320');
  });

  test('archives from the row and finds it under the archive filter', async ({ page }) => {
    const row = sessionRow(page, LABEL.chartsDarkMode);
    await row.hover();
    await rowButton(row, 'Archive').click();
    await expect(row).toHaveCount(0);

    await sidebarFilter(page, 'archived').click();
    await expect(sessionRow(page, LABEL.chartsDarkMode)).toBeVisible();
    await expect(sessionRow(page, LABEL.graphqlSpike)).toBeVisible();
  });

  test('filters by search text', async ({ page }) => {
    await searchBox(page).fill('billing');
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await expect(sessionRow(page, LABEL.billingGroup).first()).toBeVisible();
  });

  test('the running filter shows only live sessions', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await sidebarFilter(page, 'running').click();
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);
  });
});

forEachAppearance(() => {
  test('sidebar, default', async ({ page }) => {
    await expectScreen(page, 'sidebar-default');
  });

  test('sidebar, older sessions expanded', async ({ page }) => {
    await sidebar(page).getByText('+ 3 older', { exact: true }).click();
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeVisible();
    await expectScreen(page, 'sidebar-older-expanded');
  });

  test('sidebar, running filter', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.status({ state: 'working' });
    await sidebarFilter(page, 'running').click();
    await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);
    await expectScreen(page, 'sidebar-filter-running');
  });

  test('sidebar, pinned filter', async ({ page }) => {
    await sidebarFilter(page, 'pinned').click();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await expectScreen(page, 'sidebar-filter-pinned');
  });

  test('sidebar, today filter', async ({ page }) => {
    await sidebarFilter(page, 'today').click();
    await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);
    await expectScreen(page, 'sidebar-filter-today');
  });

  test('sidebar, archived filter', async ({ page }) => {
    await sidebarFilter(page, 'archived').click();
    await expect(sessionRow(page, LABEL.graphqlSpike)).toBeVisible();
    await expectScreen(page, 'sidebar-filter-archived');
  });

  test('sidebar, search', async ({ page }) => {
    await searchBox(page).fill('login');
    await expect(sessionRow(page, LABEL.chartsDarkMode)).toHaveCount(0);
    await expectScreen(page, 'sidebar-search');
  });
});
