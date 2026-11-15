/**
 * The component suite: the built renderer in a plain Chromium page, with a
 * fake `window.api` in the preload's place (support/fake-api.ts). No Electron,
 * so it runs anywhere Chromium does, and many at a time.
 */
import {defineConfig} from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    fullyParallel: true,
    // A page each, not an app each: a CI runner's four cores take four at once.
    workers: process.env.CI ? 4 : undefined,
    retries: process.env.CI ? 1 : 0,
    forbidOnly: !!process.env.CI,
    timeout: 15_000,
    expect: {timeout: 5_000},
    reporter: process.env.CI
        ? [['list'], ['html', {open: 'never', outputFolder: '../playwright-report-component'}]]
        : 'list',
    outputDir: '../test-results/component',
    use: {
        browserName: 'chromium',
        viewport: {width: 1280, height: 800},
        colorScheme: 'light',
        trace: 'retain-on-failure',
    },
});
