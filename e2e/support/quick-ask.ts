/**
 * The Quick Ask pop-up (#142) from a test: its page, and its screenshots.
 *
 * The pop-up is a second window, made hidden at startup, so `page` is never
 * it; it is found among the app's windows by the page it loads.
 */
import { expect, test } from '@playwright/test';
import { SCREENSHOTS_SKIPPED } from './app';
import type { ElectronApplication, Page } from '@playwright/test';

/** The pop-up's page, once it has loaded. */
export async function quickAskPage(app: ElectronApplication): Promise<Page> {
  const find = (): Page | undefined => app.windows().find(page => page.url().includes('/quick-ask/'));
  await expect.poll(() => !!find(), { message: 'the Quick Ask window to exist' }).toBe(true);
  const page = find()!;
  await page.waitForLoadState('domcontentloaded');
  // As for the main window (see `settleWindow`): the scheme is the app's own,
  // not the `light` Playwright would otherwise emulate.
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: null });
  return page;
}

/**
 * Compare the pop-up's whole window against `<name>-<scheme>-<platform>.png`.
 *
 * One capture, not `toHaveScreenshot`'s wait for two identical ones: "Started
 * in …" shows for only 0.7 s (B7). Nothing in the pop-up moves under reduced
 * motion, so one capture is as stable.
 */
export async function expectPopUp(page: Page, name: string): Promise<void> {
  const scheme = await page.evaluate(() =>
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const file = `${name}-${scheme}.png`;
  if (SCREENSHOTS_SKIPPED) {
    test.info().annotations.push({ type: 'screenshot skipped', description: file });
    return;
  }
  const shot = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  expect(shot).toMatchSnapshot(file, { maxDiffPixelRatio: 0.01 });
}
