/**
 * Finding a plan in the Projects modal and opening it without a session
 * (#128) in the real app: → on a project lists its plans from a stubbed back
 * end, picking one opens the Plan view in the main area, and Esc closes the
 * detail first and then the view.
 *
 * The order, the recent list, the filter and the keys are unit tested in
 * test/plan-picker.test.ts; the page's open and close rules in
 * test/plan-page-slice.test.ts.
 */
import { test, expect } from '../support/test';
import { dialog, sidebar } from '../support/app';
import { P } from '../fixtures/standard';
import { plansStub } from '../fixtures/plans';
import type { Page } from '@playwright/test';

/** Set to a directory to keep a screenshot of the plan list and of the view, to look at. */
const SHOTS = process.env.SB_E2E_PLAN_PICKER_SHOTS;

function picker(page: Page) {
  return dialog(page, 'Projects');
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

async function openPicker(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(picker(page).getByText(P.acmeApi, { exact: true })).toBeVisible();
}

test.use({ stubs: { plans: plansStub() } });

test('→ on a project lists its plans, and picking one opens it without a session', async ({ page }) => {
  /* Given */
  const rowsBefore = await sessionRows(page).count();
  await openPicker(page);
  if (SHOTS) await picker(page).screenshot({ path: SHOTS + '/plan-picker-projects.png', animations: 'disabled' });
  await picker(page).getByLabel('Filter projects').fill('acme-api');

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
  await expect(planPage(page).getByRole('heading', { level: 1 })).toHaveText('Plan · Development/acme-api');
  await expect(planPage(page).getByRole('heading', { name: 'Login rework' })).toBeVisible();
  await expect(planPage(page).getByTestId('plan-diagram').getByRole('button', { name: /^#1302 / })).toBeVisible();
  await expect(page.getByTestId('empty-screen')).toBeHidden();
  await expect(sessionRows(page)).toHaveCount(rowsBefore);
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
  await page.keyboard.press('Escape');

  /* Then */
  await expect(planPage(page)).toHaveCount(0);
  await expect(page.getByTestId('plan-page')).toBeHidden();
  await expect(page.getByTestId('empty-screen')).toBeVisible();
});

test('a plan opened from the picker comes first the next time', async ({ page }) => {
  /* Given */
  await openPicker(page);
  await picker(page).getByLabel('Filter projects').fill('acme-api');
  await page.keyboard.press('Tab');
  await plans(page).getByRole('option', { name: /#1200 / }).click();
  await expect(planPage(page)).toBeVisible();
  await planPage(page).getByRole('button', { name: 'Close plan (Esc)' }).click();
  await expect(planPage(page)).toHaveCount(0);

  /* When */
  await openPicker(page);
  await picker(page).getByLabel('Filter projects').fill('acme-api');
  await page.keyboard.press('Tab');

  /* Then */
  await expect(plans(page).getByRole('option').first()).toHaveAccessibleName(/^#1200 /);

  /* When */
  await page.keyboard.press('Shift+Tab');

  /* Then */
  await expect(picker(page).getByLabel('Filter projects')).toHaveValue('acme-api');
});

test('a project with no GitHub remote says so, and loses its → cue', async ({ page }) => {
  /* Given */
  await openPicker(page);
  await picker(page).getByLabel('Filter projects').fill('web-dashboard');
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
