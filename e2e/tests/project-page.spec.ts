/**
 * The project page (#173) in the real app: a project's name opens it, with no
 * sidebar row lit, and Esc brings the session it covered back, focused and
 * lit; ⌘-click on the name opens GitHub instead; and a session in its
 * Sessions section opens that session in its place. With a stubbed overview
 * (#174), a plan expands to its issues with the keys, ↵ opens it inside the
 * page and coming back finds it expanded, and / filters the rows. The pull
 * requests show with their plan chip, which expands that plan, Show merged
 * adds the merged one, and ↵ opens one on GitHub; with `gh` signed out one
 * message stands in for the GitHub sections (#175).
 *
 * The page's own state (expanded plans, Show closed, cursor, filter, what is
 * remembered per project) and the Sessions section's choice are unit tested
 * in test/project-page-slice.test.ts, its rows and keys in
 * test/project-page-plans.test.ts; the pull requests, worktrees and edge
 * states in test/project-page-prs-worktrees.test.ts; the route in
 * test/main-area-slice.test.ts.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sidebar, terminalHeader } from '../support/app';
import { clipboardWrites, openedExternally } from '../support/main-process';
import { sessionItem } from '../support/session-list';
import { LABEL, P, S } from '../fixtures/standard';
import { acmeOverview, plansStub } from '../fixtures/plans';
import type { Page } from '@playwright/test';

function projectPage(page: Page) {
  return page.getByRole('region', { name: 'Project ' + P.acmeApi });
}

/** The lit rows: the highlight is the row's `active` class. */
function litRows(page: Page) {
  return sidebar(page).locator('[data-session-id].active');
}

function terminalInput(page: Page) {
  return page.getByRole('textbox', { name: 'Terminal input' });
}

/** A row's project label: the way into the project's page. */
function rowProjectLink(page: Page, sessionId: string) {
  return sessionItem(page, sessionId).getByTestId('project-link');
}

test('clicking a session’s project label opens the project page with no row lit, and Esc brings the terminal back, focused and lit', async ({ page, home }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);

  /* When */
  await rowProjectLink(page, S.loginFix).click();

  /* Then */
  await expect(projectPage(page).getByRole('heading', { level: 1 })).toHaveText(P.acmeApi);
  await expect(projectPage(page)).toBeFocused();
  await expect(litRows(page)).toHaveCount(0);
  await expect(terminalHeader(page)).toBeHidden();
  const sessions = projectPage(page).getByRole('region', { name: 'Sessions' });
  await expect(sessions.getByRole('button', { name: new RegExp(LABEL.loginFix) })).toBeVisible();
  await expect(sessions.getByRole('button', { name: new RegExp(LABEL.worktreeTry) })).toBeVisible();
  await expect(sessions.getByRole('button', { name: new RegExp(LABEL.chartsDarkMode) })).toHaveCount(0);

  /* When */
  await page.keyboard.press('Escape');

  /* Then */
  await expect(projectPage(page)).toHaveCount(0);
  await expect(page.getByTestId('project-page')).toBeHidden();
  await expect(terminalHeader(page)).toBeVisible();
  await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
  await expect(litRows(page)).toHaveCount(1);
  await expect(terminalInput(page)).toBeFocused();
});

test('⌘-click on a project’s name opens its repository on GitHub and leaves the session on screen', async ({ page, app, home }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);

  /* When */
  await rowProjectLink(page, S.loginFix).click({ modifiers: ['Meta'] });

  /* Then */
  await expect.poll(() => openedExternally(app)).toEqual(['repository:' + home.projectPath(P.acmeApi)]);
  await expect(projectPage(page)).toHaveCount(0);
  await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
});

test('the project name in the terminal header opens the page, and a session in it opens in the page’s place', async ({ page, home }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);

  /* When */
  await terminalHeader(page).getByTestId('project-link').click();

  /* Then */
  await expect(projectPage(page)).toBeVisible();
  await expect(litRows(page)).toHaveCount(0);

  /* When */
  await projectPage(page).getByRole('region', { name: 'Sessions' })
    .getByRole('button', { name: new RegExp(LABEL.worktreeTry) }).click();

  /* Then */
  await expect(projectPage(page)).toHaveCount(0);
  await expect(sessionItem(page, S.worktreeTry)).toHaveClass(/\bactive\b/);
  await expect(litRows(page)).toHaveCount(1);
});

test.describe('plans and issues', () => {
  test.use({ stubs: { projectOverview: { [P.acmeApi]: acmeOverview() }, plans: plansStub() } });

  function plansSection(page: Page) {
    return projectPage(page).getByRole('region', { name: 'Plans & issues' });
  }

  /** The issue rows under the plans and under "Not in a plan", by their titles, in order. */
  function issueTitles(page: Page) {
    return plansSection(page).locator('.pp-issue .pp-issue-title');
  }

  test('a plan is one row that expands to its issues in level order, with the keys, and ↵ opens it inside the page', async ({ page }) => {
    /* Given */
    await rowProjectLink(page, S.loginFix).click();
    await expect(plansSection(page).getByText('Login rework', { exact: true })).toBeVisible();
    await expect(projectPage(page).getByText('acme/api ↗')).toBeVisible();
    await expect(issueTitles(page)).toHaveText([
      'Health check times out behind the proxy', 'Document the rate limits', 'Retry webhooks with backoff',
    ]);
    await expect(plansSection(page).getByText('Move to Postgres 16')).toHaveCount(0);

    /* When */
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');

    /* Then */
    await expect(plansSection(page).getByRole('button', { name: 'Collapse plan Login rework' })).toHaveAttribute('aria-expanded', 'true');
    await expect(issueTitles(page)).toHaveText([
      'Stop the login redirect loop', 'Remember me for 30 days', 'Single sign-on with the identity provider',
      'Cookie store behind a port', 'Magic links',
      'Health check times out behind the proxy', 'Document the rate limits', 'Retry webhooks with backoff',
    ]);
    await expect(plansSection(page).locator('.pp-issue').filter({ hasText: 'Stop the login redirect loop' })).toContainText('#1320 open');
    await expect(plansSection(page).locator('.pp-issue').filter({ hasText: 'Single sign-on' })).toContainText('waits on #1302, #1303');

    /* When */
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');

    /* Then */
    await expect(issueTitles(page)).toHaveCount(3);

    /* When */
    await plansSection(page).getByRole('button', { name: 'Show closed' }).click();

    /* Then */
    await expect(plansSection(page).getByText('Move to Postgres 16')).toBeVisible();

    /* When */
    await projectPage(page).focus();
    await page.keyboard.press('Enter');

    /* Then */
    await expect(page.getByRole('region', { name: /^Plan in / }).getByRole('heading', { name: 'Login rework' })).toBeVisible();

    /* When */
    await page.keyboard.press('Meta+BracketLeft');

    /* Then: the plan viewed last comes back expanded */
    await expect(plansSection(page).getByRole('button', { name: 'Collapse plan Login rework' })).toBeVisible();
  });

  test('the pin on a plan’s page puts it under Pinned plans, as a row that opens the page and unpins it', async ({ page }) => {
    /* Given */
    const planPage = page.getByRole('region', { name: /^Plan in / });
    const pinnedRow = sidebar(page).locator('.pinned-plan-item').filter({ hasText: 'Login rework' });
    await rowProjectLink(page, S.loginFix).click();
    await expect(plansSection(page).getByText('Login rework', { exact: true })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(planPage.getByRole('heading', { name: 'Login rework' })).toBeVisible();

    /* When */
    await planPage.getByTestId('plan-page-pin').click();

    /* Then */
    await expect(planPage.getByTestId('plan-page-pin')).toHaveAttribute('aria-pressed', 'true');
    await expect(sidebar(page).getByText('Pinned plans', { exact: true })).toBeVisible();
    await expect(pinnedRow).toHaveClass(/\bactive\b/);

    /* When */
    await page.keyboard.press('Meta+BracketLeft');
    await pinnedRow.click();

    /* Then */
    await expect(planPage.getByRole('heading', { name: 'Login rework' })).toBeVisible();

    /* When */
    await pinnedRow.getByTestId('issue-plan-pin').click();

    /* Then */
    await expect(pinnedRow).toHaveCount(0);
    await expect(sidebar(page).getByText('Pinned plans', { exact: true })).toHaveCount(0);
    await expect(planPage.getByTestId('plan-page-pin')).toHaveAttribute('aria-pressed', 'false');
  });

  test('/ filters the rows by text, and Esc clears the filter before it closes the page', async ({ page }) => {
    /* Given */
    await rowProjectLink(page, S.loginFix).click();
    await expect(issueTitles(page)).toHaveCount(3);

    /* When */
    await page.keyboard.press('/');
    await page.keyboard.type('remember');

    /* Then */
    await expect(issueTitles(page)).toHaveText(['Remember me for 30 days']);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(issueTitles(page)).toHaveCount(3);
    await expect(projectPage(page)).toBeFocused();
  });

  test('the pull requests show with their plan chip, which expands the plan; Show merged adds the merged one; ↵ opens one on GitHub', async ({ page, app }) => {
    /* Given */
    await rowProjectLink(page, S.loginFix).click();
    const prs = projectPage(page).getByRole('region', { name: 'Pull requests' });
    const rows = prs.locator('.pp-pr');
    await expect(rows.locator('.pp-pr-title')).toHaveText([
      'Stop the login redirect loop', 'Try a token-bucket rate limiter', 'Bump express to 5.1',
    ]);
    await expect(rows.nth(0)).toContainText('● running');
    await expect(rows.nth(0)).toContainText('review requested');
    await expect(rows.nth(1)).toHaveClass(/\bis-draft\b/);
    await expect(rows.nth(2)).toContainText('✕ 2 failing');
    const worktrees = projectPage(page).getByRole('region', { name: 'Worktrees' });
    await expect(worktrees.locator('.pp-worktree-branch')).toHaveText(['main', 'fix/1320', 'rate-limiter', 'cookie-store']);

    /* When */
    await rows.nth(0).getByRole('button', { name: 'in #1300' }).click();

    /* Then */
    await expect(plansSection(page).getByRole('button', { name: 'Collapse plan Login rework' })).toHaveAttribute('aria-expanded', 'true');

    /* When */
    await prs.getByRole('button', { name: 'Show merged' }).click();

    /* Then */
    await expect(rows.locator('.pp-pr-title')).toHaveText([
      'Stop the login redirect loop', 'Try a token-bucket rate limiter', 'Bump express to 5.1', 'Cookie store behind a port',
    ]);
    await expect(worktrees.locator('.pp-worktree').filter({ hasText: 'cookie-store' })).toContainText('merged in #1310 · safe to remove');

    /* When */
    await projectPage(page).focus();
    await page.keyboard.press('/');
    await page.keyboard.type('express');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    /* Then */
    await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/pull/1331');
  });

  forEachAppearance(() => {
    test('the project page with its plans and issues', async ({ page, home }) => {
      /* Given */
      await rowProjectLink(page, S.loginFix).click();
      await expect(issueTitles(page)).toHaveCount(3);

      /* When */
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');

      /* Then */
      await expect(issueTitles(page)).toHaveCount(8);
      await expectScreen(page, 'project-page-plans', { mask: [projectPage(page).getByText(home.projectPath(P.acmeApi), { exact: true })] });
    });
  });
});

forEachAppearance(() => {
  test('the project page, with its header and its sessions', async ({ page, home }) => {
    /* When */
    await rowProjectLink(page, S.loginFix).click();

    /* Then */
    await expect(projectPage(page)).toBeVisible();
    // The fixture home is a fresh temporary directory each run.
    await expectScreen(page, 'project-page', { mask: [projectPage(page).getByText(home.projectPath(P.acmeApi), { exact: true })] });
  });
});

test.describe('GitHub CLI signed out', () => {
  test.use({ stubs: { projectOverview: { [P.acmeApi]: { ...acmeOverview(), github: { ok: false, reason: 'signed-out' } } } } });

  test('one message stands in for plans and pull requests, with Try again and Copy command', async ({ page, app }) => {
    /* When */
    await rowProjectLink(page, S.loginFix).click();

    /* Then */
    const message = projectPage(page).getByRole('status', { name: 'GitHub' });
    await expect(message).toContainText('Plans, issues and pull requests come from the GitHub CLI');
    await expect(message).toContainText('Run gh auth login in a terminal, then try again.');
    await expect(projectPage(page).getByRole('region', { name: 'Plans & issues' })).toHaveCount(0);
    await expect(projectPage(page).getByRole('region', { name: 'Pull requests' })).toHaveCount(0);
    await expect(projectPage(page).getByRole('region', { name: 'Sessions' })).toBeVisible();
    await expect(message.getByRole('button', { name: 'Try again' })).toBeVisible();

    /* When */
    await message.getByRole('button', { name: 'Copy command' }).click();

    /* Then */
    await expect.poll(() => clipboardWrites(app)).toEqual(['gh auth login']);
  });
});
