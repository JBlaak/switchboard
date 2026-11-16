/**
 * The Quick Ask pop-up (#142) from a test: its page.
 *
 * The pop-up is a second window, made hidden at startup, so `page` is never
 * it; it is found among the app's windows by the page it loads.
 */
import {expect} from '@playwright/test';
import type {ElectronApplication, Page} from '@playwright/test';

/** The pop-up's page, once it has loaded. */
export async function quickAskPage(app: ElectronApplication): Promise<Page> {
    const find = (): Page | undefined => app.windows().find((page) => page.url().includes('/quick-ask/'));
    await expect.poll(() => !!find(), {message: 'the Quick Ask window to exist'}).toBe(true);
    const page = find()!;
    await page.waitForLoadState('domcontentloaded');
    // As for the main window (see `settleWindow`): the scheme is the app's own,
    // not the `light` Playwright would otherwise emulate.
    await page.emulateMedia({reducedMotion: 'reduce', colorScheme: null});
    return page;
}
