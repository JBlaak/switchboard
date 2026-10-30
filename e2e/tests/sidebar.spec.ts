/**
 * The session list: tiers, truncation, slug groups, filters and search, drawn
 * from the standard fixture.
 *
 * The order, the folding and the filters are decided by the list's layout
 * (test/session-list-layout.test.ts, test/session-list-slice.test.ts); this
 * walks the list the real index drew, and what its clicks ask main for.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  expectScreen, openSession, rowButton, searchBox, sessionRow, sidebar, sidebarFilter, terminalStatus,
} from '../support/app';
import { openedExternally } from '../support/main-process';
import { fakeClaude } from '../support/fake-cli';
import { LABEL, S } from '../fixtures/standard';

test('lists, folds, searches, archives and filters what the index found', async ({ page, app, home }) => {
  /* Then */
  // Pinned first, then recent, and old sessions folded away.
  await expect(sidebar(page).getByText('Pinned', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('Recent', { exact: true })).toBeVisible();
  await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
  await expect(sessionRow(page, LABEL.meetingNotes)).toBeHidden();
  await expect(sessionRow(page, LABEL.graphqlSpike)).toHaveCount(0);
  // A renamed session shows by its name, a worktree by its branch.
  await expect(sessionRow(page, LABEL.chartsDarkMode)).toBeVisible();
  await expect(sidebar(page).getByText('Development/old-parser ⎇ streaming', { exact: true })).toBeVisible();
  // A worktree whose checkout still exists lists under its repository.
  await expect(sessionRow(page, LABEL.worktreeTry)).toBeVisible();
  await expect(sidebar(page).getByText('Development/acme-api ⎇ session-cookie')).toHaveCount(0);
  // Sessions sharing a slug fold into one group.
  await expect(sidebar(page).getByText('3 sessions', { exact: true })).toBeVisible();
  await expect(sessionRow(page, 'Implement the plan: extract the invoice model')).toBeHidden();

  /* When */
  await sidebar(page).getByText('+ 3 older', { exact: true }).click();

  /* Then */
  await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
  await expect(sessionRow(page, LABEL.bumpDeps)).toBeVisible();

  /* When */
  await sessionRow(page, LABEL.billingGroup).first().click();

  /* Then */
  await expect(sessionRow(page, 'Implement the plan: extract the invoice model')).toBeVisible();

  /* When */
  await searchBox(page).fill('billing');

  /* Then */
  await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
  await expect(sessionRow(page, LABEL.billingGroup).first()).toBeVisible();

  /* When */
  await searchBox(page).fill('');
  const charts = sessionRow(page, LABEL.chartsDarkMode);
  await charts.hover();
  await rowButton(charts, 'Archive').click();

  /* Then */
  await expect(charts).toHaveCount(0);

  /* When */
  await expect(sidebar(page).getByText('+1', { exact: true })).toBeVisible();
  // Outside a git repository the meta line is text, so the click is the row's.
  await sidebar(page).getByText('#1320', { exact: true }).click();

  /* Then */
  // A pull request chip is display only: it no longer opens the browser.
  await fakeClaude(home, S.loginFix).launched();
  await expect(terminalStatus(page)).toHaveText('Running');
  expect(await openedExternally(app)).toEqual([]);

  /* When */
  await sidebarFilter(page, 'running').click();

  /* Then */
  await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
  await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);
});

test('Undo on the toast brings an archived row back', async ({ page }) => {
  /* Given */
  const charts = sessionRow(page, LABEL.chartsDarkMode);
  await charts.hover();
  await rowButton(charts, 'Archive').click();
  await expect(charts).toHaveCount(0);
  const toast = page.getByTestId('archive-undo');
  await expect(toast).toContainText(`Archived “${LABEL.chartsDarkMode}”`);

  /* When */
  await toast.getByRole('button', { name: /Undo/ }).click();

  /* Then */
  await expect(toast).toHaveCount(0);
  await expect(charts).toBeVisible();
  await expect(charts).not.toHaveAttribute('data-leaving');
});

forEachAppearance(() => {
  test('sidebar screens', async ({ page, home }) => {
    /* Then */
    await expectScreen(page, 'sidebar-default', { soft: true });

    /* When */
    await sidebar(page).getByText('+ 3 older', { exact: true }).click();
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeVisible();

    /* Then */
    await expectScreen(page, 'sidebar-older-expanded', { soft: true });

    /* When */
    await sidebarFilter(page, 'pinned').click();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);

    /* Then */
    await expectScreen(page, 'sidebar-filter-pinned', { soft: true });

    /* When */
    await sidebarFilter(page, 'pinned').click();
    await searchBox(page).fill('login');
    await expect(sessionRow(page, LABEL.chartsDarkMode)).toHaveCount(0);

    /* Then */
    await expectScreen(page, 'sidebar-search', { soft: true });

    /* When */
    await searchBox(page).fill('');
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.status({ state: 'working' });
    await sidebarFilter(page, 'running').click();
    await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);

    /* Then */
    await expectScreen(page, 'sidebar-filter-running', { soft: true });
  });
});
