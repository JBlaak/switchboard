/**
 * The sidebar's chrome above the session list: the toolbar, the filter row,
 * the search box, collapsing and resizing.
 *
 * The rules behind them are tested in node: the filters and the search's
 * narrowing (`test/toolbar-slice`, `test/toolbar-search-filters`,
 * `test/session-list-layout`), the appearance cycle and its title
 * (`test/appearance`, `test/toolbar-appearance-title`) and the sleep switch
 * (`test/toolbar-sleep-switch`). These keep what needs the real app: the
 * round trips to main (search, settings, the theme, the sleep switch), the
 * drag on the real window, and how the chrome looks.
 *
 * The list itself is sidebar.spec.ts's; these only look at it to see what the
 * controls did to it.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  expectScreen, openSession, searchBox, sessionRow, sidebar, sidebarFilter,
} from '../support/app';
import { breakSearch, setHostStub } from '../support/main-process';
import { LABEL, S, standardFixture } from '../fixtures/standard';
import type { Locator, Page } from '@playwright/test';

const SEARCH_DEBOUNCE_MS = 200;

function button(page: Page, name: string | RegExp): Locator {
  return page.getByRole('button', { name, exact: typeof name === 'string' });
}

const clearButton = (page: Page) => button(page, 'Clear search');
const titlesToggle = (page: Page) => button(page, 'Search titles only');
const appearanceButton = (page: Page) => button(page, /^Appearance: /);
const sleepButton = (page: Page) => button(page, /sleep|awake/i);
const quickSessionButton = (page: Page) => page.getByTitle('Quick session (⌘N)');
const resizeHandle = (page: Page) => page.getByTestId('sidebar-resize-handle');

const SLEEP_ALLOWED = 'This Mac can sleep (click to keep it awake)';
const SLEEP_DISABLED = 'Sleep is disabled: this Mac stays awake (click to allow sleep)';

/** The list's section labels, which only an unfiltered list shows. */
async function expectSectionLabels(page: Page, visible: boolean): Promise<void> {
  for (const label of ['Pinned', 'Recent']) {
    const locator = sidebar(page).getByText(label, { exact: true });
    if (visible) await expect(locator).toBeVisible();
    else await expect(locator).toHaveCount(0);
  }
}

async function sidebarWidth(page: Page): Promise<number> {
  return (await sidebar(page).boundingBox())!.width;
}

async function storedGlobal(page: Page): Promise<Record<string, unknown>> {
  return (await page.evaluate(() => window.api.getSetting<Record<string, unknown>>('global'))) ?? {};
}

/** Reload the window and wait for the list to be drawn again. */
async function reload(page: Page): Promise<void> {
  await page.reload();
  await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
}

test.describe('resize handle', () => {
  test('clamps the width to 200–600px, refits the terminal and persists the width on release only', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    // xterm's own element, sized to the grid it last fitted.
    const screen = page.locator('.xterm-screen').first();
    const gridWidth = async () => (await screen.boundingBox())!.width;
    const fitted = await gridWidth();
    const box = (await resizeHandle(page).boundingBox())!;
    const y = box.y + box.height / 2;
    const before = (await storedGlobal(page)).sidebarWidth;

    /* When */
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();

    /* Then */
    // The drag locks the cursor and text selection for the whole page.
    expect(await page.evaluate(() => [document.body.style.cursor, document.body.style.userSelect]))
      .toEqual(['col-resize', 'none']);

    /* When */
    await page.mouse.move(80, y, { steps: 4 });

    /* Then */
    expect(await sidebarWidth(page)).toBe(200);

    /* When */
    await page.mouse.move(900, y, { steps: 4 });

    /* Then */
    expect(await sidebarWidth(page)).toBe(600);

    /* When */
    await page.mouse.move(220, y, { steps: 4 });

    /* Then */
    expect(await sidebarWidth(page)).toBe(220);
    // Nothing is written, and the terminal is not refitted, mid-drag.
    expect((await storedGlobal(page)).sidebarWidth).toBe(before);
    expect(await gridWidth()).toBe(fitted);

    /* When */
    await page.mouse.up();

    /* Then */
    expect(await page.evaluate(() => [document.body.style.cursor, document.body.style.userSelect]))
      .toEqual(['', '']);
    await expect.poll(async () => (await storedGlobal(page)).sidebarWidth).toBe(220);
    await expect.poll(gridWidth).toBeGreaterThan(fitted);

    /* When */
    await page.mouse.move(300, y, { steps: 2 });

    /* Then */
    // Moving the mouse after release no longer drags.
    expect(await sidebarWidth(page)).toBe(220);

    /* When */
    await reload(page);

    /* Then */
    // Applied again at boot.
    await expect.poll(() => sidebarWidth(page)).toBe(220);
  });
});

test.describe('filters', () => {
  test('narrow the list, replace one another and hide the section labels until turned off', async ({ page }) => {
    /* Given */
    const pinned = sidebarFilter(page, 'pinned');
    const running = sidebarFilter(page, 'running');

    /* When */
    await pinned.click();

    /* Then */
    await expect(pinned).toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await expectSectionLabels(page, false);

    /* When */
    await running.click();

    /* Then */
    await expect(running).toHaveClass(/\bactive\b/);
    await expect(pinned).not.toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);

    /* When */
    // Clicking the active one again turns it off.
    await running.click();

    /* Then */
    await expect(running).not.toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expectSectionLabels(page, true);
  });
});

test.describe('toolbar buttons', () => {
  test('the lightning bolt appears once a quick session folder is saved', async ({ page }) => {
    /* Given */
    await expect(quickSessionButton(page)).toBeHidden();
    await button(page, 'Global settings').click();
    await page.getByPlaceholder('/path/to/folder').fill('/tmp');

    /* When */
    await button(page, 'Save Settings').click();

    /* Then */
    await expect(quickSessionButton(page)).toBeVisible();
  });
});

test.describe('search', () => {
  test('queries main after the debounce; emptying or clearing the box, or a failing query, brings the list back', async ({ page, app }) => {
    /* When */
    // Typed in the page itself, so the two checks are timed against the
    // keystroke rather than against Playwright's round trips.
    const seen = await page.evaluate(async (debounceMs) => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder="Search sessions..."]')!;
      const clear = document.querySelector<HTMLElement>('button[aria-label="Clear search"]')!;
      const listed = () => document.body.innerText.includes('Fix the login redirect loop');
      // Through the prototype's setter, as typing does: a renderer that tracks
      // the field's value (React does) must still see this as a change.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'billing');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(requestAnimationFrame);
      const clearShown = getComputedStyle(clear).display !== 'none';
      await new Promise(resolve => setTimeout(resolve, debounceMs / 2));
      return { clearShown, stillListed: listed() };
    }, SEARCH_DEBOUNCE_MS);

    /* Then */
    // The box is marked at once, and the list only narrows after the debounce.
    expect(seen).toEqual({ clearShown: true, stillListed: true });
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await expect(sessionRow(page, LABEL.billingGroup).first()).toBeVisible();
    await expectSectionLabels(page, false);

    /* When */
    await searchBox(page).fill('');

    /* Then */
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(clearButton(page)).toBeHidden();
    await expectSectionLabels(page, true);

    /* When */
    // An archived session, found through the search index in main.
    await searchBox(page).fill('GraphQL');

    /* Then */
    await expect(sessionRow(page, LABEL.graphqlSpike)).toBeVisible();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);

    /* When */
    await clearButton(page).click();

    /* Then */
    await expect(searchBox(page)).toHaveValue('');
    await expect(searchBox(page)).toBeFocused();
    await expect(clearButton(page)).toBeHidden();
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();

    /* When */
    await breakSearch(app);
    await searchBox(page).fill('billing');
    // Give the debounce its time; the list must come back whole, not empty.
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS * 2);

    /* Then */
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
    await expectSectionLabels(page, true);
  });
});

test.describe('titles only', () => {
  test('re-runs the current query, matches project names, and is remembered', async ({ page }) => {
    /* Given */
    // Every multi-message transcript has replies saying "Working on it", in
    // the body only.
    await searchBox(page).fill('Working on it');
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();

    /* When */
    await titlesToggle(page).click();

    /* Then */
    await expect(titlesToggle(page)).toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    expect(await page.evaluate(() => window.api.getSetting('searchTitlesOnly'))).toBe(true);

    /* When */
    await searchBox(page).fill('web-dash');

    /* Then */
    // A matched project shows all of its sessions.
    await expect(sessionRow(page, LABEL.chartsDarkMode)).toBeVisible();
    await expect(sessionRow(page, LABEL.flakyE2e)).toBeVisible();
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeVisible();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);

    /* When */
    await reload(page);

    /* Then */
    // Loaded at boot.
    await expect(titlesToggle(page)).toHaveClass(/\bactive\b/);
  });
});

test.describe('appearance', () => {
  test('a click moves to the next mode, which main applies and stores', async ({ page }) => {
    /* Given */
    // The harness starts every app in light.
    await expect(appearanceButton(page)).toHaveAttribute('title', 'Appearance: Light (click for Dark)');
    const dark = () => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);

    /* When */
    await appearanceButton(page).click();

    /* Then */
    await expect(appearanceButton(page)).toHaveAttribute('title', 'Appearance: Dark (click for System)');
    await expect.poll(dark).toBe(true);
    await expect.poll(async () => (await storedGlobal(page)).appearance).toBe('dark');
  });
});

test.describe('sleep toggle', () => {
  test('flips only once the switch answers, and hides once the host cannot say', async ({ page, app }) => {
    /* Given */
    await setHostStub(app, 'sleepPromptDelayMs', 600);
    await expect(sleepButton(page)).toHaveAttribute('title', SLEEP_ALLOWED);

    /* When */
    await sleepButton(page).click();

    /* Then */
    // Waiting on the prompt: disabled, and still showing the old state.
    await expect(sleepButton(page)).toBeDisabled();
    await expect(sleepButton(page)).toHaveAttribute('title', SLEEP_ALLOWED);
    await expect(sleepButton(page)).toBeEnabled();
    await expect(sleepButton(page)).toHaveAttribute('title', SLEEP_DISABLED);

    /* When */
    // Read again when the window regains focus.
    await setHostStub(app, 'sleepDisabled', null);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    /* Then */
    await expect(appearanceButton(page)).toBeVisible();
    await expect(sleepButton(page)).toBeHidden();
  });
});

test.describe('collapse', () => {
  test('Cmd+S hides and shows the sidebar, from the search box too', async ({ page }) => {
    /* When */
    await page.keyboard.press('Meta+s');

    /* Then */
    await expect(searchBox(page)).toBeHidden();
    await expect(button(page, 'Show sidebar')).toBeVisible();
    expect(await sidebarWidth(page)).toBe(42);

    /* When */
    await page.keyboard.press('Meta+s');

    /* Then */
    await expect(searchBox(page)).toBeVisible();
    await expect(button(page, 'Show sidebar')).toBeHidden();

    /* When */
    await searchBox(page).focus();
    await page.keyboard.press('Meta+s');

    /* Then */
    await expect(searchBox(page)).toBeHidden();
  });
});

forEachAppearance(() => {
  test('sidebar, collapsed', async ({ page }) => {
    /* When */
    await button(page, 'Hide sidebar').click();

    /* Then */
    await expect(searchBox(page)).toBeHidden();
    await expect(sessionRow(page, LABEL.loginFix)).toBeHidden();
    await expect(resizeHandle(page)).toBeHidden();
    expect(await sidebarWidth(page)).toBe(42);
    await expectScreen(page, 'sidebar-collapsed');

    /* When */
    // Cmd+L has no list to hand the keyboard to while it is collapsed.
    await page.keyboard.press('Meta+l');
    await button(page, 'Show sidebar').click();

    /* Then */
    await expect(searchBox(page)).toBeVisible();
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(button(page, 'Show sidebar')).toBeHidden();
    await expect(sidebar(page).locator(':focus')).toHaveCount(0);
  });

  test.describe('every toolbar control showing', () => {
    test.use({
      fixture: { ...standardFixture(), settings: { quickSessionPath: '/tmp' } },
      stubs: { sleepDisabled: true },
    });

    test('toolbar, all controls', async ({ page }) => {
      /* Given */
      // A quick session folder set at boot shows the lightning bolt.
      await expect(quickSessionButton(page)).toBeVisible();
      await expect(sleepButton(page)).toHaveAttribute('title', SLEEP_DISABLED);

      /* When */
      await titlesToggle(page).click();
      await searchBox(page).fill('billing');

      /* Then */
      await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
      await expectScreen(page, 'toolbar-all-controls');

      // The header drags the window, and its controls opt out so a click on
      // one is a click: Playwright's clicks would land either way.
      const region = (locator: Locator) =>
        locator.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
      const parentRegion = (locator: Locator) =>
        locator.evaluate(el => getComputedStyle(el.closest('#sidebar > *')!).getPropertyValue('-webkit-app-region'));
      for (const name of ['Global settings', 'Hide sidebar', 'New session', 'Add project']) {
        expect(await region(button(page, name))).toBe('no-drag');
      }
      for (const filter of ['running', 'pinned'] as const) {
        expect(await region(sidebarFilter(page, filter))).toBe('no-drag');
      }
      expect(await region(appearanceButton(page))).toBe('no-drag');
      expect(await region(sleepButton(page))).toBe('no-drag');
      // The strip they sit in is a drag handle; the search box below it is not.
      expect(await parentRegion(button(page, 'Global settings'))).toBe('drag');
      expect(await parentRegion(searchBox(page))).not.toBe('drag');
    });
  });
});
