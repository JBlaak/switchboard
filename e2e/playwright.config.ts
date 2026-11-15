/**
 * The end-to-end suite: the built app, driven through Playwright's Electron
 * support against a fixture home. See the "End-to-end tests" section of
 * CONTRIBUTING.md for how to run it.
 *
 * Kept out of the unit glob (`test/*.test.ts`) on purpose: these need a build,
 * a display and several seconds per test.
 */
import {defineConfig} from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    // Each test launches its own app, so tests are independent; a few at a time
    // is what a laptop's CPU takes without the terminals' timing starting to
    // wobble.
    fullyParallel: true,
    workers: process.env.CI ? 2 : 3,
    retries: process.env.CI ? 1 : 0,
    forbidOnly: !!process.env.CI,
    timeout: 60_000,
    expect: {
        timeout: 10_000,
    },
    reporter: process.env.CI ? [['list'], ['html', {open: 'never', outputFolder: '../playwright-report'}]] : 'list',
    outputDir: '../test-results/e2e',
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
});
