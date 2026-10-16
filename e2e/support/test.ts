/**
 * The `test` every spec imports: Playwright's, with a fixture home and a
 * launched app per test.
 *
 * ```ts
 * import { test, expect } from '../support/test';
 *
 * test.use({ fixture: standardFixture(), appearance: 'dark' });
 *
 * test('shows the pinned session', async ({ page }) => {
 *   await expect(page.getByText(LABEL.releaseNotes)).toBeVisible();
 * });
 * ```
 *
 * `page` is the app's window (the browser `page` Playwright would otherwise
 * start is never launched). `app` is the ElectronApplication, for reaching the
 * main process; `home` is the fixture, for the fake CLIs and the paths.
 *
 * The app is launched and the sidebar has finished its first index by the time
 * the test body runs, so a test starts from a settled screen.
 */
import { test as base, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fixtureHome } from './fixture-home';
import { launchApp } from './launch';
import { waitForIndex } from './app';
import { standardFixture } from '../fixtures/standard';
import type { FixtureHome, FixtureSpec } from './fixture-home';
import type { HostStubs } from './main-process';

export interface HarnessOptions {
  /** What the fixture home holds. Defaults to the standard fixture. */
  fixture: FixtureSpec;
  /** The app's own appearance setting, so both schemes are the app's real ones. */
  appearance: 'light' | 'dark';
  /** Overrides for the host stubs (usage, sleep, folder picker). */
  stubs: Partial<HostStubs>;
}

export interface HarnessFixtures {
  home: FixtureHome;
  app: ElectronApplication;
  page: Page;
}

export const test = base.extend<HarnessOptions & HarnessFixtures>({
  fixture: [standardFixture(), { option: true }],
  appearance: ['light', { option: true }],
  stubs: [{}, { option: true }],

  home: async ({ fixture, appearance }, use) => {
    const home = fixtureHome({ ...fixture, settings: { ...fixture.settings, appearance } });
    await use(home);
    home.dispose();
  },

  // One launch backs both `app` and `page`; `page` asks for `app` so the two
  // always belong to the same process.
  app: async ({ home, stubs }, use) => {
    const launched = await launchApp(home, stubs);
    try {
      await waitForIndex(launched.page, launched.app, home);
      await use(launched.app);
    } finally {
      await launched.close();
    }
  },

  page: async ({ app }, use) => {
    await use(await app.firstWindow());
  },
});

export { expect };

/** Run the enclosed tests once per colour scheme, named "… (light)" / "… (dark)". */
export function forEachAppearance(define: (appearance: 'light' | 'dark') => void): void {
  for (const appearance of ['light', 'dark'] as const) {
    test.describe(appearance, () => {
      test.use({ appearance });
      define(appearance);
    });
  }
}
