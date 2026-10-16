/**
 * The empty screen: what a first launch shows, with nothing indexed and
 * nothing running.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, searchBox } from '../support/app';
import { emptyFixture } from '../fixtures/standard';

test.use({ fixture: emptyFixture() });

test.describe('smoke', () => {
  test('greets with Patch and an empty session list', async ({ page }) => {
    await expect(page.getByText('nothing running', { exact: false })).toBeVisible();
    await expect(searchBox(page)).toBeVisible();
    await expect(page.getByText('Recent', { exact: true })).toHaveCount(0);
  });
});

forEachAppearance(() => {
  test('empty screen', async ({ page }) => {
    await expect(page.getByText('nothing running', { exact: false })).toBeVisible();
    await expectScreen(page, 'empty-screen');
  });
});
