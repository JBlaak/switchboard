/**
 * The project page (#173) in the real app: a project's name opens it, with no
 * sidebar row lit, and Esc brings the session it covered back, focused and
 * lit; ⌘-click on the name opens GitHub instead; and a session in its
 * Sessions section opens that session in its place.
 *
 * The page's own state (expanded plans, Show closed, cursor, filter, what is
 * remembered per project) and the Sessions section's choice are unit tested
 * in test/project-page-slice.test.ts; the route in test/main-area-slice.test.ts.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sidebar, terminalHeader } from '../support/app';
import { openedExternally } from '../support/main-process';
import { sessionItem } from '../support/session-list';
import { LABEL, P, S } from '../fixtures/standard';
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
