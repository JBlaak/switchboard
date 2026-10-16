/**
 * The end-to-end suite: the built app, driven through Playwright's Electron
 * support against a fixture home. See the "End-to-end tests" section of the
 * README for how to run it and how to update the screenshot baselines.
 *
 * Kept out of the unit glob (`test/*.test.ts`) on purpose: these need a build,
 * a display and several seconds per test.
 */
import { defineConfig } from '@playwright/test';

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
    toHaveScreenshot: {
      // Antialiasing on text edges differs by a few pixels between otherwise
      // identical runs; anything that is a real change moves far more.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  // Baselines are per platform, so a Linux run never compares against Mac
  // pixels: tests/__screenshots__/<spec>/<name>-<scheme>-<platform>.png, the
  // scheme being added by expectScreen (support/app.ts).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{platform}{ext}',
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]]
    : 'list',
  outputDir: '../test-results/e2e',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
