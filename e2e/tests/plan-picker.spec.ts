/**
 * Finding a plan in the New Session picker and opening it without a session
 * (#128) in the real app: → on a project lists its plans from a stubbed back
 * end, picking one opens the Plan view inside the project's page with no
 * sidebar row lit (#168, #173), ⌘[ goes back to the project's overview, and
 * Esc closes the detail first and then the page, back to the session it
 * covered.
 *
 * The order, the recent list, the filter and the keys are unit tested in
 * test/plan-picker.test.ts; the main area's route and its highlight in
 * test/main-area-slice.test.ts.
 */
import { test, expect } from '../support/test';
import { dialog, openSession, sidebar } from '../support/app';
import { sessionItem } from '../support/session-list';
import { LABEL, P, S } from '../fixtures/standard';
import { plansStub } from '../fixtures/plans';
import type { Page } from '@playwright/test';

/** Set to a directory to keep a screenshot of the plan list and of the view, to look at. */
const SHOTS = process.env.SB_E2E_PLAN_PICKER_SHOTS;

function picker(page: Page) {
  return dialog(page, 'New Session');
}

function plans(page: Page) {
  return page.getByRole('listbox', { name: 'Plans' });
}

function planPage(page: Page) {
  return page.getByRole('region', { name: /^Plan in / });
}

function sessionRows(page: Page) {
  return sidebar(page).locator('[data-session-id]');
}

/** The lit rows: the highlight is the row's `active` class. */
function litRows(page: Page) {
  return sidebar(page).locator('[data-session-id].active');
}

function terminalInput(page: Page) {
  return page.getByRole('textbox', { name: 'Terminal input' });
}

/** Open acme-api's "Login rework" plan through the picker. */
async function openLoginRework(page: Page): Promise<void> {
  await openPicker(page);
  await picker(page).getByPlaceholder('Filter projects...').fill('acme-api');
  await page.keyboard.press('ArrowRight');
  await expect(plans(page).getByRole('option').first()).toHaveAccessibleName(/^#1300 /);
  await page.keyboard.press('Enter');
  await expect(planPage(page).getByRole('heading', { name: 'Login rework' })).toBeVisible();
}

async function openPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(picker(page).getByText(P.acmeApi, { exact: true })).toBeVisible();
}

test.use({ stubs: { plans: plansStub() } });

test('→ on a project lists its plans, and picking one opens it without a session', async ({ page }) => {
  /* Given */
  const rowsBefore = await sessionRows(page).count();
  await openPicker(page);
  if (SHOTS) await picker(page).screenshot({ path: SHOTS + '/plan-picker-projects.png', animations: 'disabled' });
  await picker(page).getByPlaceholder('Filter projects...').fill('acme-api');

  /* When */
  await page.keyboard.press('ArrowRight');

  /* Then */
  await expect(plans(page).getByRole('option')).toHaveText([
    /#1300\s*Login rework.*Level 2 of 3.*2 \/ 5 closed/,
    /#1200\s*Rate limiting at the edge.*Level 1 of 2.*2 \/ 4 closed/,
    'Show closed',
  ]);
  await expect(picker(page).getByPlaceholder('Filter plans by title or #number')).toBeFocused();

  /* When */
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  /* Then */
  await expect(plans(page).getByRole('option', { name: /#900 Move to Postgres 16/ })).toBeVisible();
  await expect(plans(page).getByRole('option', { name: 'Show closed' })).toHaveCount(0);
  if (SHOTS) await picker(page).screenshot({ path: SHOTS + '/plan-picker-list.png' });

  /* When */
  await picker(page).getByPlaceholder('Filter plans by title or #number').fill('#13');

  /* Then */
  await expect(plans(page).getByRole('option')).toHaveText([/#1300\s*Login rework/]);

  /* When */
  await page.keyboard.press('Enter');

  /* Then */
  await expect(picker(page)).toHaveCount(0);
  await expect(planPage(page).getByRole('button', { name: 'Back to Development/acme-api (⌘[)' })).toBeVisible();
  await expect(planPage(page).getByRole('heading', { name: 'Login rework' })).toBeVisible();
  await expect(planPage(page).getByTestId('plan-diagram').getByRole('button', { name: /^#1302 / })).toBeVisible();
  await expect(page.getByTestId('empty-screen')).toBeHidden();
  await expect(sessionRows(page)).toHaveCount(rowsBefore);
  await expect(litRows(page)).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: SHOTS + '/plan-page.png' });

  /* When */
  await planPage(page).getByTestId('plan-diagram').getByRole('button', { name: /^#1302 / }).click();

  /* Then */
  const detail = planPage(page).getByRole('complementary', { name: 'Issue detail' });
  await expect(detail.getByRole('heading', { name: 'Stop the login redirect loop' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: SHOTS + '/plan-page-detail.png' });

  /* When */
  await page.keyboard.press('Escape');

  /* Then */
  await expect(detail).toHaveCount(0);
  await expect(planPage(page)).toBeVisible();

  /* When */
  await page.keyboard.press('Meta+BracketLeft');

  /* Then */
  await expect(planPage(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Project Development/acme-api' })).toBeFocused();
  await expect(litRows(page)).toHaveCount(0);

  /* When */
  await page.keyboard.press('Escape');

  /* Then */
  await expect(page.getByTestId('project-page')).toBeHidden();
  await expect(page.getByTestId('empty-screen')).toBeVisible();
});

test('a plan opened over a session lights no row, and Esc brings the session back, lit and focused', async ({ page, home }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);

  /* When */
  await openLoginRework(page);

  /* Then */
  await expect(litRows(page)).toHaveCount(0);
  await expect(page.getByTestId('terminal-header')).toBeHidden();

  /* When */
  await page.keyboard.press('Escape');

  /* Then */
  await expect(planPage(page)).toHaveCount(0);
  await expect(page.getByTestId('terminal-header')).toBeVisible();
  await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
  await expect(litRows(page)).toHaveCount(1);
  await expect(terminalInput(page)).toBeFocused();
});

test('clicking a sidebar row while a plan is open shows that session and closes the plan', async ({ page, home }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await openLoginRework(page);

  /* When */
  await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);

  /* Then */
  await expect(planPage(page)).toHaveCount(0);
  await expect(page.getByTestId('project-page')).toBeHidden();
  await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bactive\b/);
  await expect(litRows(page)).toHaveCount(1);
});

test('a plan opened from the picker comes first the next time', async ({ page }) => {
  /* Given */
  await openPicker(page);
  await picker(page).getByPlaceholder('Filter projects...').fill('acme-api');
  await page.keyboard.press('Tab');
  await plans(page).getByRole('option', { name: /#1200 / }).click();
  await expect(planPage(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(planPage(page)).toHaveCount(0);

  /* When */
  await openPicker(page);
  await picker(page).getByPlaceholder('Filter projects...').fill('acme-api');
  await page.keyboard.press('Tab');

  /* Then */
  await expect(plans(page).getByRole('option').first()).toHaveAccessibleName(/^#1200 /);

  /* When */
  await page.keyboard.press('Shift+Tab');

  /* Then */
  await expect(picker(page).getByPlaceholder('Filter projects...')).toHaveValue('acme-api');
});

test('a project with no GitHub remote says so, and loses its → cue', async ({ page }) => {
  /* Given */
  await openPicker(page);
  await picker(page).getByPlaceholder('Filter projects...').fill('web-dashboard');
  const cue = picker(page).getByRole('button', { name: 'Show plans' });
  await expect(cue).toHaveCount(1);

  /* When */
  await page.keyboard.press('ArrowRight');

  /* Then */
  await expect(picker(page).getByRole('status')).toContainText('no GitHub remote');

  /* When */
  await page.keyboard.press('ArrowLeft');

  /* Then */
  await expect(picker(page).getByText(P.webDashboard, { exact: true })).toBeVisible();
  await expect(cue).toHaveCount(0);
});
