/**
 * The sidebar's chrome above the session list: the toolbar, the filter row,
 * the search box, collapsing and resizing — everything issue #57 moves to
 * React, pinned down against the vanilla renderer first.
 *
 * The list itself is sidebar.spec.ts's; these only look at it to see what the
 * controls did to it.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  dialog, expectScreen, openSession, searchBox, sessionRow, sidebar, sidebarFilter,
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

test.describe('collapse and expand', () => {
  test('hides the sidebar behind a rail and brings it back', async ({ page }) => {
    await button(page, 'Hide sidebar').click();
    await expect(searchBox(page)).toBeHidden();
    await expect(sessionRow(page, LABEL.loginFix)).toBeHidden();
    await expect(resizeHandle(page)).toBeHidden();
    expect(await sidebarWidth(page)).toBe(42);

    await button(page, 'Show sidebar').click();
    await expect(searchBox(page)).toBeVisible();
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(button(page, 'Show sidebar')).toBeHidden();
  });

  test('Cmd+S hides and shows the sidebar, from the search box too', async ({ page }) => {
    await page.keyboard.press('Meta+s');
    await expect(searchBox(page)).toBeHidden();
    await expect(button(page, 'Show sidebar')).toBeVisible();
    expect(await sidebarWidth(page)).toBe(42);

    await page.keyboard.press('Meta+s');
    await expect(searchBox(page)).toBeVisible();
    await expect(button(page, 'Show sidebar')).toBeHidden();

    await searchBox(page).focus();
    await page.keyboard.press('Meta+s');
    await expect(searchBox(page)).toBeHidden();
  });

  test('is not persisted', async ({ page }) => {
    await button(page, 'Hide sidebar').click();
    await expect(searchBox(page)).toBeHidden();
    await reload(page);
    await expect(searchBox(page)).toBeVisible();
  });

  test('Cmd+L does nothing while collapsed', async ({ page }) => {
    // Expanded, Cmd+L hands the keyboard to the list.
    await page.keyboard.press('Meta+l');
    await expect(sidebar(page).locator(':focus')).toHaveCount(1);
    await page.mouse.click(900, 400);
    await expect(sidebar(page).locator(':focus')).toHaveCount(0);

    await button(page, 'Hide sidebar').click();
    await page.keyboard.press('Meta+l');
    await button(page, 'Show sidebar').click();
    await expect(searchBox(page)).toBeVisible();
    await expect(sidebar(page).locator(':focus')).toHaveCount(0);
  });
});

test.describe('resize handle', () => {
  test('clamps the width to 200–600px and persists it on release only', async ({ page }) => {
    const box = (await resizeHandle(page).boundingBox())!;
    const y = box.y + box.height / 2;
    const before = (await storedGlobal(page)).sidebarWidth;

    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    // The drag locks the cursor and text selection for the whole page.
    expect(await page.evaluate(() => [document.body.style.cursor, document.body.style.userSelect]))
      .toEqual(['col-resize', 'none']);

    await page.mouse.move(80, y, { steps: 4 });
    expect(await sidebarWidth(page)).toBe(200);
    await page.mouse.move(900, y, { steps: 4 });
    expect(await sidebarWidth(page)).toBe(600);
    await page.mouse.move(420, y, { steps: 4 });
    expect(await sidebarWidth(page)).toBe(420);
    // Nothing is written mid-drag.
    expect((await storedGlobal(page)).sidebarWidth).toBe(before);

    await page.mouse.up();
    expect(await page.evaluate(() => [document.body.style.cursor, document.body.style.userSelect]))
      .toEqual(['', '']);
    await expect.poll(async () => (await storedGlobal(page)).sidebarWidth).toBe(420);

    // Moving the mouse after release no longer drags.
    await page.mouse.move(300, y, { steps: 2 });
    expect(await sidebarWidth(page)).toBe(420);

    // Applied again at boot.
    await reload(page);
    await expect.poll(() => sidebarWidth(page)).toBe(420);
  });

  test('refits the open terminal on release', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    // xterm's own element, sized to the grid it last fitted.
    const screen = page.locator('.xterm-screen').first();
    const gridWidth = async () => (await screen.boundingBox())!.width;
    const fitted = await gridWidth();

    const box = (await resizeHandle(page).boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(220, y, { steps: 4 });
    expect(await gridWidth()).toBe(fitted);
    await page.mouse.up();
    await expect.poll(gridWidth).toBeGreaterThan(fitted);
  });
});

test.describe('filters', () => {
  test('running, pinned and archived replace one another', async ({ page }) => {
    const running = sidebarFilter(page, 'running');
    const pinned = sidebarFilter(page, 'pinned');
    const archived = sidebarFilter(page, 'archived');

    await pinned.click();
    await expect(pinned).toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);

    await archived.click();
    await expect(archived).toHaveClass(/\bactive\b/);
    await expect(pinned).not.toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.graphqlSpike)).toBeVisible();
    await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);

    await running.click();
    await expect(running).toHaveClass(/\bactive\b/);
    await expect(archived).not.toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.graphqlSpike)).toHaveCount(0);

    // Clicking the active one again turns it off.
    await running.click();
    await expect(running).not.toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expectSectionLabels(page, true);
  });

  test('today combines with the others', async ({ page }) => {
    const today = sidebarFilter(page, 'today');
    const pinned = sidebarFilter(page, 'pinned');

    await today.click();
    await expect(today).toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);

    // The pinned session is five days old, so pinned-and-today is empty, and
    // turning pinned on leaves today on.
    await pinned.click();
    await expect(today).toHaveClass(/\bactive\b/);
    await expect(pinned).toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await expect(sessionRow(page, LABEL.releaseNotes)).toHaveCount(0);

    await pinned.click();
    await expect(today).toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
  });

  test('hide the section labels while any filter is on', async ({ page }) => {
    await expectSectionLabels(page, true);
    for (const filter of ['running', 'pinned', 'today', 'archived'] as const) {
      await sidebarFilter(page, filter).click();
      await expectSectionLabels(page, false);
      await sidebarFilter(page, filter).click();
      await expectSectionLabels(page, true);
    }
  });

  test('are not persisted', async ({ page }) => {
    await sidebarFilter(page, 'pinned').click();
    await sidebarFilter(page, 'today').click();
    await reload(page);
    await expect(sidebarFilter(page, 'pinned')).not.toHaveClass(/\bactive\b/);
    await expect(sidebarFilter(page, 'today')).not.toHaveClass(/\bactive\b/);
    await expectSectionLabels(page, true);
  });
});

test.describe('toolbar buttons', () => {
  test('gear opens global settings', async ({ page }) => {
    await button(page, 'Global settings').click();
    await expect(page.getByText('Global Settings — Global', { exact: true })).toBeVisible();
  });

  test('add project opens its dialog', async ({ page }) => {
    await button(page, 'Add project').click();
    await expect(dialog(page, 'Add Project')).toBeVisible();
  });

  test('+ opens the project picker', async ({ page }) => {
    await button(page, 'New session').click();
    await expect(dialog(page, 'New Session')).toBeVisible();
  });

  test('the lightning bolt appears once a quick session folder is saved', async ({ page }) => {
    await expect(quickSessionButton(page)).toBeHidden();
    await button(page, 'Global settings').click();
    await page.getByPlaceholder('/path/to/folder').fill('/tmp');
    await button(page, 'Save Settings').click();
    await expect(quickSessionButton(page)).toBeVisible();
  });

  test('the loading status is quiet after the first load', async ({ page }) => {
    await expect(sidebar(page).getByText('Loading…')).toBeHidden();
    // A reload with projects already cached shows no status.
    await page.evaluate(() => window.api.getProjects(false));
    await sidebarFilter(page, 'archived').click();
    await expect(sidebar(page).getByText('Loading…')).toBeHidden();
  });
});

test.describe('quick session folder already set', () => {
  test.use({ fixture: { ...standardFixture(), settings: { quickSessionPath: '/tmp' } } });

  test('the lightning bolt shows at boot', async ({ page }) => {
    await expect(quickSessionButton(page)).toBeVisible();
  });
});

test.describe('search', () => {
  test('marks the box at once and queries after the debounce', async ({ page }) => {
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
    expect(seen).toEqual({ clearShown: true, stillListed: true });

    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await expect(sessionRow(page, LABEL.billingGroup).first()).toBeVisible();
    await expectSectionLabels(page, false);
  });

  test('an empty query clears the search', async ({ page }) => {
    await searchBox(page).fill('billing');
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await searchBox(page).fill('');
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(clearButton(page)).toBeHidden();
    await expectSectionLabels(page, true);
  });

  test('a failing query falls back to the unfiltered list', async ({ page, app }) => {
    await breakSearch(app);
    await searchBox(page).fill('billing');
    // Give the debounce its time; the list must come back whole, not empty.
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS * 2);
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
    await expectSectionLabels(page, true);
  });

  test('ignores the archive filter and covers every project', async ({ page }) => {
    await searchBox(page).fill('GraphQL');
    await expect(sessionRow(page, LABEL.graphqlSpike)).toBeVisible();

    await searchBox(page).fill('planning meeting');
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
  });

  test('clear empties the box and puts the focus back in it', async ({ page }) => {
    await searchBox(page).fill('billing');
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await clearButton(page).click();
    await expect(searchBox(page)).toHaveValue('');
    await expect(searchBox(page)).toBeFocused();
    await expect(clearButton(page)).toBeHidden();
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
  });
});

test.describe('titles only', () => {
  test('re-runs the current query when toggled, and is persisted', async ({ page }) => {
    // Every multi-message transcript has replies saying "Working on it", in
    // the body only.
    await searchBox(page).fill('Working on it');
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();

    await titlesToggle(page).click();
    await expect(titlesToggle(page)).toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    expect(await page.evaluate(() => window.api.getSetting('searchTitlesOnly'))).toBe(true);

    await titlesToggle(page).click();
    await expect(titlesToggle(page)).not.toHaveClass(/\bactive\b/);
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    expect(await page.evaluate(() => window.api.getSetting('searchTitlesOnly'))).toBe(false);
  });

  test('is loaded at boot', async ({ page }) => {
    await page.evaluate(() => window.api.setSetting('searchTitlesOnly', true));
    await reload(page);
    await expect(titlesToggle(page)).toHaveClass(/\bactive\b/);
  });

  test('matches project names and shows all of a matched project', async ({ page }) => {
    await titlesToggle(page).click();
    await searchBox(page).fill('web-dash');
    await expect(sessionRow(page, LABEL.chartsDarkMode)).toBeVisible();
    await expect(sessionRow(page, LABEL.flakyE2e)).toBeVisible();
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeVisible();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
  });
});

test.describe('appearance', () => {
  test('cycles system → light → dark and names the next mode', async ({ page }) => {
    // The harness starts every app in light.
    await expect(appearanceButton(page)).toHaveAttribute('title', 'Appearance: Light (click for Dark)');
    const dark = () => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);

    await appearanceButton(page).click();
    await expect(appearanceButton(page)).toHaveAttribute('title', 'Appearance: Dark (click for System)');
    await expect.poll(dark).toBe(true);
    await expect.poll(async () => (await storedGlobal(page)).appearance).toBe('dark');

    await appearanceButton(page).click();
    await expect(appearanceButton(page)).toHaveAttribute('title', 'Appearance: System (click for Light)');
    await expect.poll(async () => (await storedGlobal(page)).appearance).toBe('system');

    await appearanceButton(page).click();
    await expect(appearanceButton(page)).toHaveAttribute('title', 'Appearance: Light (click for Dark)');
    await expect.poll(dark).toBe(false);
    await expect.poll(async () => (await storedGlobal(page)).appearance).toBe('light');
  });
});

test.describe('sleep toggle', () => {
  test('flips only once the switch answers, and shows the cup while sleep is off', async ({ page, app }) => {
    await setHostStub(app, 'sleepPromptDelayMs', 600);
    await expect(sleepButton(page)).toHaveAttribute('title', 'This Mac can sleep (click to keep it awake)');

    await sleepButton(page).click();
    // Waiting on the prompt: disabled, and still showing the old state.
    await expect(sleepButton(page)).toBeDisabled();
    await expect(sleepButton(page)).toHaveAttribute('title', 'This Mac can sleep (click to keep it awake)');

    await expect(sleepButton(page)).toBeEnabled();
    await expect(sleepButton(page))
      .toHaveAttribute('title', 'Sleep is disabled: this Mac stays awake (click to allow sleep)');
  });

  test('a cancelled prompt leaves the state as it was', async ({ page, app }) => {
    await setHostStub(app, 'sleepPromptCancelled', true);
    await sleepButton(page).click();
    await expect(sleepButton(page)).toBeEnabled();
    await expect(sleepButton(page)).toHaveAttribute('title', 'This Mac can sleep (click to keep it awake)');
  });

  test('is read again when the window regains focus', async ({ page, app }) => {
    await expect(sleepButton(page)).toHaveAttribute('title', 'This Mac can sleep (click to keep it awake)');
    await setHostStub(app, 'sleepDisabled', true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(sleepButton(page))
      .toHaveAttribute('title', 'Sleep is disabled: this Mac stays awake (click to allow sleep)');
  });

  test('is read again every minute', async ({ page, app }) => {
    test.slow();
    await expect(sleepButton(page)).toHaveAttribute('title', 'This Mac can sleep (click to keep it awake)');
    await setHostStub(app, 'sleepDisabled', true);
    await expect(sleepButton(page))
      .toHaveAttribute('title', 'Sleep is disabled: this Mac stays awake (click to allow sleep)', { timeout: 65_000 });
  });
});

test.describe('sleep toggle on a host that cannot say', () => {
  test.use({ stubs: { sleepDisabled: null } });

  test('is hidden', async ({ page }) => {
    await expect(appearanceButton(page)).toBeVisible();
    await expect(sleepButton(page)).toBeHidden();
  });
});

test.describe('window drag regions', () => {
  test('the header drags the window and its controls opt out', async ({ page }) => {
    const region = (locator: Locator) =>
      locator.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
    const parentRegion = (locator: Locator) =>
      locator.evaluate(el => getComputedStyle(el.closest('#sidebar > *')!).getPropertyValue('-webkit-app-region'));

    for (const name of ['Global settings', 'Hide sidebar', 'New session', 'Add project']) {
      expect(await region(button(page, name))).toBe('no-drag');
    }
    for (const filter of ['running', 'pinned', 'today', 'archived'] as const) {
      expect(await region(sidebarFilter(page, filter))).toBe('no-drag');
    }
    expect(await region(appearanceButton(page))).toBe('no-drag');
    expect(await region(sleepButton(page))).toBe('no-drag');
    // The strip they sit in is a drag handle; the search box below it is not.
    expect(await parentRegion(button(page, 'Global settings'))).toBe('drag');
    expect(await parentRegion(searchBox(page))).not.toBe('drag');
  });
});

forEachAppearance(() => {
  test('sidebar, collapsed', async ({ page }) => {
    await button(page, 'Hide sidebar').click();
    await expect(searchBox(page)).toBeHidden();
    await expectScreen(page, 'sidebar-collapsed');
  });

  test.describe('every toolbar control showing', () => {
    test.use({
      fixture: { ...standardFixture(), settings: { quickSessionPath: '/tmp' } },
      stubs: { sleepDisabled: true },
    });

    test('toolbar, all controls', async ({ page }) => {
      await expect(quickSessionButton(page)).toBeVisible();
      await expect(sleepButton(page))
        .toHaveAttribute('title', 'Sleep is disabled: this Mac stays awake (click to allow sleep)');
      await titlesToggle(page).click();
      await searchBox(page).fill('billing');
      await sidebarFilter(page, 'today').click();
      await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
      await expectScreen(page, 'toolbar-all-controls');
    });
  });
});
