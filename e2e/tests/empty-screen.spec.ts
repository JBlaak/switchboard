/**
 * The empty screen: what a first launch shows, with nothing indexed and
 * nothing running.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, searchBox, sidebar } from '../support/app';
import { hostStubCalls } from '../support/main-process';
import { LABEL, S, emptyFixture, standardFixture } from '../fixtures/standard';
import type { Page } from '@playwright/test';

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

// ── Patch on the empty screen ──

const FIRST_LINE = 'Zzz… nothing running. Wake me when you start something.';

/** Patch's speech bubble, by what it says. */
const says = (page: Page, line: string | RegExp) => page.locator('#placeholder').getByText(line);

/** Put the empty screen away behind global settings and bring it back. */
async function hideAndShowEmptyScreen(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  await expect(page.getByText('Global Settings — Global', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
  await expect(page.getByText('Global Settings — Global', { exact: true })).toBeHidden();
}

test.describe('patch', () => {
  test('appears, with its next line, each time the empty screen is shown', async ({ page }) => {
    await expect(says(page, FIRST_LINE)).toBeVisible();
    await hideAndShowEmptyScreen(page);
    await expect(says(page, 'All quiet on the board. Start a session?')).toBeVisible();
    await hideAndShowEmptyScreen(page);
    await expect(says(page, FIRST_LINE)).toBeVisible();
  });

  test.describe('in the rain', () => {
    test.use({ stubs: { weather: { sky: 'rain', isDay: true, location: 'Utrecht', fetchedAt: 0 } } });

    test('reads the weather, for the season', async ({ page }) => {
      await expect(says(page, FIRST_LINE)).toBeVisible();
      await hideAndShowEmptyScreen(page);
      // The fixture's clock is in June: summer rain means a puddle, not an umbrella.
      await expect(says(page, 'Warm rain! Puddle jumping later.')).toBeVisible();
      await expect(page.locator('#placeholder .patch-scene')).toHaveClass(/patch-has-puddle/);
      await expect(page.locator('#placeholder .patch-scene')).not.toHaveClass(/patch-has-umbrella/);
    });
  });

  test.describe('on Koningsdag', () => {
    test('dresses for the holiday over the season', async ({ page }) => {
      await expect(says(page, FIRST_LINE)).toBeVisible();
      await page.clock.setFixedTime(new Date('2027-04-27T12:00:00Z'));
      await hideAndShowEmptyScreen(page);
      await expect(says(page, 'Oranje boven! Fijne Koningsdag!')).toBeVisible();
      await expect(page.locator('#placeholder .patch-scene')).toHaveClass(/patch-has-crown/);
    });
  });

  test.describe('near the limit', () => {
    test.use({
      stubs: {
        usage: {
          limits: [{ kind: 'session', label: 'Current session', model: null, percent: 88, reset: '6pm (UTC)', severity: 'normal' }],
        },
      },
    });

    test('reads the usage', async ({ page }) => {
      await expect(says(page, 'We’re at 88% of the limit. Easy does it.')).toBeVisible();
    });
  });

  test.describe('with a session running', () => {
    test.use({ fixture: standardFixture() });

    test('reads the running count', async ({ page, home }) => {
      await expect(says(page, FIRST_LINE)).toBeVisible();
      await openSession(page, home, LABEL.loginFix, S.loginFix);
      // Clicking the list anywhere but on a row or a control (here, a section
      // heading) puts the session away.
      await sidebar(page).getByText('Recent', { exact: true }).click();
      // The second appearance with one session running.
      await expect(says(page, 'Missed you.')).toBeVisible();
    });
  });

  test.describe('when the weather never answers', () => {
    test.use({ stubs: { weather: 'never' } });

    test('goes with what it has after 1.5s', async ({ page }) => {
      await expect(says(page, FIRST_LINE)).toBeVisible();
      await hideAndShowEmptyScreen(page);
      const shownAt = Date.now();
      await expect(says(page, 'All quiet on the board. Start a session?')).toBeVisible({ timeout: 4000 });
      expect(Date.now() - shownAt).toBeGreaterThanOrEqual(1200);
    });

    test('a poke answers at once and wins over the gather in flight', async ({ page }) => {
      await expect(says(page, FIRST_LINE)).toBeVisible();
      await hideAndShowEmptyScreen(page);
      // The gather for this appearance is waiting on the weather now.
      await page.locator('#placeholder').getByRole('button', { name: 'Poke Patch' }).click();
      await expect(says(page, 'Hey, that tickles!')).toBeVisible({ timeout: 500 });
      await page.waitForTimeout(2000);
      await expect(says(page, 'Hey, that tickles!')).toBeVisible();
    });

    test('a drop answers at once and wins over the gather in flight', async ({ page }) => {
      await expect(says(page, FIRST_LINE)).toBeVisible();
      await hideAndShowEmptyScreen(page);
      const patch = page.locator('#placeholder').getByRole('button', { name: 'Poke Patch' });
      const box = (await patch.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 });
      await page.mouse.up();
      const dropLine = /Wheee!|Again! Again!|all wobbly|Right back where I belong|Where was I|That was fun/;
      await expect(says(page, dropLine)).toBeVisible({ timeout: 500 });
      const line = await says(page, dropLine).textContent();
      await page.waitForTimeout(2000);
      await expect(says(page, line!)).toBeVisible();
    });
  });

  test('warms the weather cache as the window loads', async ({ app }) => {
    await expect.poll(async () => (await hostStubCalls(app)).getWeather).toBeGreaterThanOrEqual(1);
  });
});
