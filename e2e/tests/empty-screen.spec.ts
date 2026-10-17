/**
 * The empty screen: what a first launch shows, with nothing indexed and
 * nothing running.
 *
 * What Patch says for a given board — the beats, the weather and holiday
 * asides, the usage lines, pokes and drops — is unit tested
 * (test/patch-mood.test.ts, test/patch-calendar.test.ts). These check that
 * the board reaches Patch: each appearance, the weather and usage from main,
 * the running count, and a reaction beating a slow gather.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, searchBox, sidebar } from '../support/app';
import { hostStubCalls } from '../support/main-process';
import { LABEL, S, emptyFixture, standardFixture } from '../fixtures/standard';
import type { Page } from '@playwright/test';

test.use({ fixture: emptyFixture() });

// ── Patch on the empty screen ──

const FIRST_LINE = 'Zzz… nothing running. Wake me when you start something.';

/** Patch's speech bubble, by what it says. */
const says = (page: Page, line: string | RegExp) => page.locator('#placeholder').getByText(line);

/** Put the empty screen away behind global settings and bring it back. */
async function hideAndShowEmptyScreen(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  await expect(page.getByText('Global Settings', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
  await expect(page.getByText('Global Settings', { exact: true })).toBeHidden();
}

forEachAppearance(() => {
  test('greets with Patch and an empty session list, with its next line each time it is shown', async ({ page }) => {
    /* Then */
    await expect(says(page, FIRST_LINE)).toBeVisible();
    await expect(searchBox(page)).toBeVisible();
    await expect(page.getByText('Recent', { exact: true })).toHaveCount(0);
    await expectScreen(page, 'empty-screen');

    /* When */
    await hideAndShowEmptyScreen(page);

    /* Then */
    await expect(says(page, 'All quiet on the board. Start a session?')).toBeVisible();

    /* When */
    await hideAndShowEmptyScreen(page);

    /* Then */
    await expect(says(page, FIRST_LINE)).toBeVisible();
  });
});

test.describe('patch', () => {
  test.describe('near the limit, in the rain', () => {
    test.use({
      stubs: {
        weather: { sky: 'rain', isDay: true, location: 'Utrecht', fetchedAt: 0 },
        usage: {
          limits: [{ kind: 'session', label: 'Current session', model: null, percent: 88, reset: '6pm (UTC)', severity: 'normal' }],
        },
      },
    });

    test('warms the weather as the window loads, and reads the usage, then the weather', async ({ page, app }) => {
      /* Then */
      await expect.poll(async () => (await hostStubCalls(app)).getWeather).toBeGreaterThanOrEqual(1);
      await expect(says(page, 'We’re at 88% of the limit. Easy does it.')).toBeVisible();

      /* When */
      await hideAndShowEmptyScreen(page);

      /* Then */
      // The fixture's clock is in June: summer rain means a puddle, not an umbrella.
      await expect(says(page, 'Warm rain! Puddle jumping later.')).toBeVisible();
      await expect(page.locator('#placeholder .patch-scene')).toHaveClass(/patch-has-puddle/);
      await expect(page.locator('#placeholder .patch-scene')).not.toHaveClass(/patch-has-umbrella/);
    });
  });

  test.describe('with a session running', () => {
    test.use({ fixture: standardFixture() });

    test('reads the running count', async ({ page, home }) => {
      /* Given */
      await expect(says(page, FIRST_LINE)).toBeVisible();
      await openSession(page, home, LABEL.loginFix, S.loginFix);

      /* When */
      // Clicking the list anywhere but on a row or a control (here, a section
      // heading) puts the session away.
      await sidebar(page).getByText('Recent', { exact: true }).click();

      /* Then */
      // The second appearance with one session running.
      await expect(says(page, 'Missed you.')).toBeVisible();
    });
  });

  test.describe('when the weather never answers', () => {
    test.use({ stubs: { weather: 'never' } });

    test('a poke or a drop answers at once and wins over the gather in flight, which goes with what it has after 1.5s', async ({ page }) => {
      /* Given */
      await expect(says(page, FIRST_LINE)).toBeVisible();
      const patch = page.locator('#placeholder').getByRole('button', { name: 'Poke Patch' });

      /* When */
      await hideAndShowEmptyScreen(page);
      // The gather for this appearance is waiting on the weather now.
      await patch.click();

      /* Then */
      await expect(says(page, 'Hey, that tickles!')).toBeVisible({ timeout: 500 });
      await page.waitForTimeout(2000);
      await expect(says(page, 'Hey, that tickles!')).toBeVisible();

      /* When */
      // The poke won, so this is still only Patch's second appearance.
      await hideAndShowEmptyScreen(page);
      const shownAt = Date.now();

      /* Then */
      await expect(says(page, 'All quiet on the board. Start a session?')).toBeVisible({ timeout: 4000 });
      expect(Date.now() - shownAt).toBeGreaterThanOrEqual(1200);

      /* When */
      await hideAndShowEmptyScreen(page);
      const box = (await patch.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 });
      await page.mouse.up();

      /* Then */
      const dropLine = /Wheee!|Again! Again!|all wobbly|Right back where I belong|Where was I|That was fun/;
      await expect(says(page, dropLine)).toBeVisible({ timeout: 500 });
      const line = await says(page, dropLine).textContent();
      await page.waitForTimeout(2000);
      await expect(says(page, line!)).toBeVisible();
    });
  });
});
