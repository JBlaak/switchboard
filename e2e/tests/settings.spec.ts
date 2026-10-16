/**
 * The settings viewer, in its global and per-project forms.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { dialog, expectScreen, rowButton } from '../support/app';
import { P } from '../fixtures/standard';
import type { Page } from '@playwright/test';

async function openGlobalSettings(page: Page) {
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  await expect(page.getByText('Global Settings — Global', { exact: true })).toBeVisible();
}

async function openProjectSettings(page: Page, label: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await rowButton(dialog(page, 'New Session').getByText(label, { exact: true }), 'Project settings').click();
  await expect(page.getByText(`Project Settings — ${label}`, { exact: true })).toBeVisible();
}

test.describe('smoke', () => {
  test('global settings save and close', async ({ page }) => {
    await openGlobalSettings(page);
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect(page.getByText('Global Settings — Global', { exact: true })).toBeHidden();
    const global = await page.evaluate(() => window.api.getSetting<Record<string, unknown>>('global'));
    // The form writes back what it was opened with, and keeps the harness's own keys.
    expect(global).toMatchObject({ sessionMaxAgeDays: 3, weatherEnabled: false, appearance: 'light' });
  });

  test('project settings open from the picker and cancel', async ({ page }) => {
    await openProjectSettings(page, P.acmeApi);
    await expect(page.getByRole('button', { name: 'Hide Project', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText(`Project Settings — ${P.acmeApi}`, { exact: true })).toBeHidden();
  });
});

forEachAppearance(() => {
  test('global settings', async ({ page }) => {
    await openGlobalSettings(page);
    await expectScreen(page, 'settings-global');
  });

  test('project settings', async ({ page }) => {
    await openProjectSettings(page, P.acmeApi);
    await expectScreen(page, 'settings-project');
  });
});
