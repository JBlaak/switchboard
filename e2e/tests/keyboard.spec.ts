/**
 * The keyboard, item by item of its port (#64): walking the session list with
 * a cursor, and the shortcuts that work wherever the focus is — moving between
 * open sessions, the picker, archiving, quick sessions — without one keypress
 * firing twice when it passes through the terminal on its way.
 *
 * Written against the vanilla key handling first, so the version that reads
 * the store instead of the DOM has to behave the same way to pass. Renaming
 * from the cursor, and what the cursor survives, are in `session-list.spec.ts`;
 * Cmd+L on a collapsed sidebar is in `toolbar.spec.ts`.
 */
import fs from 'node:fs';
import { test, expect } from '../support/test';
import {
  dialog, openSession, searchBox, sessionRow, sidebar, terminalHeader,
} from '../support/app';
import { terminalState } from '../support/terminal';
import { fakeClaude, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { minutesAgo, sessionId } from '../support/fixture-home';
import {
  hangInvoke, keyboardCursor, listScroller, renameInput, rowNode, sessionItem, storedSession,
} from '../support/session-list';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import type { Page } from '@playwright/test';
import type { FixtureHome, FixtureSpec } from '../support/fixture-home';

/** The terminal's keyboard target: xterm's hidden textarea. */
function terminalInput(page: Page) {
  return page.getByRole('textbox', { name: 'Terminal input' });
}

const picker = (page: Page) => dialog(page, 'New Session');
const globalSettings = (page: Page) => page.getByText('Global Settings — Global', { exact: true });

/** Take the focus away from everything, so a key lands on the document itself. */
async function blurAll(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** `count` recent sessions in one project, newest first. */
function manySessions(count: number): FixtureSpec {
  return {
    projects: [{
      path: 'Development/big',
      sessions: Array.from({ length: count }, (_, i) => ({
        id: sessionId('many-' + i),
        prompt: `Long list session ${String(i + 1).padStart(2, '0')}`,
        at: minutesAgo(10 + i * 5),
      })),
    }],
    settings: { visibleSessionCount: 100 },
  };
}

function shortList(): FixtureSpec {
  return {
    projects: [{
      path: P.notes,
      sessions: [
        { id: sessionId('short-1'), prompt: 'A short list, first', at: minutesAgo(5) },
        { id: sessionId('short-2'), prompt: 'A short list, second', at: minutesAgo(15) },
      ],
    }],
  };
}

/** The session ids of these rows, sorted by where they sit on screen. */
async function onScreenOrder(page: Page, ids: readonly string[]): Promise<string[]> {
  const placed = await Promise.all(ids.map(async id => ({ id, y: (await sessionItem(page, id).boundingBox())!.y })));
  return placed.sort((a, b) => a.y - b.y).map(p => p.id);
}

// ── The list's cursor ──

test.describe('Cmd+L', () => {
  test('puts the cursor on the first item when no session is open', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await expect(listScroller(page)).toBeFocused();
    await expect(keyboardCursor(page)).toHaveCount(1);
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);
  });

  test('puts it on the open session\'s row', async ({ page, home }) => {
    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await page.keyboard.press('Meta+l');
    await expect(listScroller(page)).toBeFocused();
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);
  });

  test('keeps a cursor that is already there', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);
    await page.keyboard.press('Meta+l');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);
  });

  test.describe('on a long list', () => {
    test.use({ fixture: manySessions(40) });

    test('does not scroll the list to the open row it lands on', async ({ page, home }) => {
      const row = sessionRow(page, 'Long list session 20');
      await row.scrollIntoViewIfNeeded();
      await openSession(page, home, 'Long list session 20', sessionId('many-19'));
      const before = await listScroller(page).evaluate(el => el.scrollTop);
      expect(before).toBeGreaterThan(0);
      await page.keyboard.press('Meta+l');
      await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', sessionId('many-19'));
      expect(await listScroller(page).evaluate(el => el.scrollTop)).toBe(before);
    });
  });
});

test.describe('the cursor keys', () => {
  test('arrows and J/K step, clamped at both ends', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowUp');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);
    await page.keyboard.press('k');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);
    await page.keyboard.press('j');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.loginFix);
    await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);
    await page.keyboard.press('k');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.loginFix);
    await page.keyboard.press('ArrowUp');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);

    // The last item is the "+ N older" toggle; the rows behind it are hidden.
    for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toHaveText(/^\+ \d+ older$/);
    await page.keyboard.press('j');
    await expect(keyboardCursor(page)).toHaveText(/^\+ \d+ older$/);
  });

  test('skip the rows of a folded group, and land on its header', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toContainText(LABEL.billingGroup);
    await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);
  });

  test('Enter does what a click would: open a row, fold a group, show older', async ({ page, home }) => {
    await page.keyboard.press('Meta+l');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect(sessionRow(page, 'Plan how to move billing out of the monolith')).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(sessionRow(page, 'Plan how to move billing out of the monolith')).toBeVisible();
    // Unfolded, the group's rows are next in line.
    await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.billingStep2);

    for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowDown');
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeVisible();

    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowUp');
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await fakeClaude(home, S.loginFix).launched();
  });

  test('E archives the row and moves the cursor to the next one', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('e');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);
    await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({ archived: 1 });
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);
  });

  test('E on a group header archives the whole group', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('e');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);
    for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
      await expect.poll(() => storedSession(page, id)).toMatchObject({ archived: 1 });
    }
  });

  test('Esc clears the cursor and hands the keyboard to the open terminal', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+l');
    await expect(keyboardCursor(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(keyboardCursor(page)).toHaveCount(0);
    await expect(terminalInput(page)).toBeFocused();
  });

  test('Esc with no session open just lets go of the list', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('Escape');
    await expect(keyboardCursor(page)).toHaveCount(0);
    await expect(listScroller(page)).not.toBeFocused();
    await expect(sidebar(page).locator(':focus')).toHaveCount(0);
  });

  test('A opens the picker', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('a');
    await expect(picker(page)).toBeVisible();
  });

  test('do nothing unless the list has the keyboard', async ({ page }) => {
    await blurAll(page);
    for (const key of ['ArrowDown', 'j', 'e', 'a', 'r']) await page.keyboard.press(key);
    await expect(keyboardCursor(page)).toHaveCount(0);
    await expect(picker(page)).toHaveCount(0);
    await expect(renameInput(page)).toHaveCount(0);
  });

  test('J, K, R, E and A are left alone with Cmd, Ctrl or Alt held', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    for (const key of ['Meta+j', 'Control+j', 'Alt+j', 'Control+k', 'Alt+k']) {
      await page.keyboard.press(key);
      await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.loginFix);
    }
    for (const key of ['Control+r', 'Alt+r', 'Control+e', 'Alt+e', 'Control+a', 'Alt+a']) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(600);
    await expect(renameInput(page)).toHaveCount(0);
    await expect(picker(page)).toHaveCount(0);
    expect(await storedSession(page, S.loginFix)).toMatchObject({ archived: 0 });
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.loginFix);
  });

  test('skip a row on its way out', async ({ page, app }) => {
    await hangInvoke(app, 'archiveSession');
    await page.getByText(LABEL.loginFix, { exact: true }).hover();
    await sessionItem(page, S.loginFix).getByRole('button', { name: 'Archive', exact: true }).click();
    await expect.poll(async () => (await rowNode(page, S.loginFix))?.leaving).toBe(true);
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);
    await page.keyboard.press('ArrowUp');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);
  });

  test('focus leaving the list clears the cursor', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.loginFix);
    await searchBox(page).click();
    await expect(keyboardCursor(page)).toHaveCount(0);
    // So the next Cmd+L starts over.
    await page.keyboard.press('Meta+l');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);
  });
});

test.describe('the cursor at the end of a short list', () => {
  test.use({ fixture: shortList() });

  test('E on the last row moves the cursor up', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', sessionId('short-2'));
    await page.keyboard.press('e');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', sessionId('short-1'));
  });
});

test.describe('the cursor on a long list', () => {
  test.use({ fixture: manySessions(40) });

  test('is scrolled into view, only as far as it has to be', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
    const cursor = keyboardCursor(page);
    await expect(cursor).toHaveAttribute('data-session-id', sessionId('many-30'));
    // All of it, give or take a fraction of a pixel.
    await expect(cursor).toBeInViewport({ ratio: 0.95 });
    // "nearest": stepping down pulls the row up to the bottom edge, no further.
    const row = (await cursor.boundingBox())!;
    const list = (await listScroller(page).boundingBox())!;
    expect(Math.abs(row.y + row.height - (list.y + list.height))).toBeLessThanOrEqual(row.height);
    const top = await listScroller(page).evaluate(el => el.scrollTop);
    expect(top).toBeGreaterThan(0);

    // Stepping back up within the screen does not scroll at all.
    await page.keyboard.press('ArrowUp');
    expect(await listScroller(page).evaluate(el => el.scrollTop)).toBe(top);
  });
});

// ── Shortcuts ──

/** Open three sessions; the last one opened is on screen. Returns them in sidebar order. */
async function openThree(page: Page, home: FixtureHome): Promise<string[]> {
  await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
  await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  return await onScreenOrder(page, [S.loginFix, S.worktreeTry, S.chartsDarkMode]);
}

const LABEL_OF: Record<string, string> = {
  [S.loginFix]: LABEL.loginFix,
  [S.worktreeTry]: LABEL.worktreeTry,
  [S.chartsDarkMode]: LABEL.chartsDarkMode,
};

async function expectOnScreen(page: Page, id: string): Promise<void> {
  await expect(sessionItem(page, id)).toHaveClass(/\bactive\b/);
  await expect(terminalHeader(page)).toContainText(LABEL_OF[id]);
}

test.describe('session navigation', () => {
  test('Cmd+Shift+] and [ step through the open sessions in sidebar order, wrapping', async ({ page, home }) => {
    const order = await openThree(page, home);
    const at = order.indexOf(S.loginFix);
    const next = (i: number) => order[(at + i + order.length * 2) % order.length];

    await page.keyboard.press('Meta+Shift+BracketRight');
    await expectOnScreen(page, next(1));
    await page.keyboard.press('Meta+Shift+BracketRight');
    await expectOnScreen(page, next(2));
    await page.keyboard.press('Meta+Shift+BracketRight');
    await expectOnScreen(page, next(3));
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expectOnScreen(page, next(2));
  });

  test('Cmd+Arrow does the same: left and up go back, right and down go on', async ({ page, home }) => {
    const order = await openThree(page, home);
    let at = order.indexOf(S.loginFix);
    for (const [key, step] of [
      ['Meta+ArrowDown', 1], ['Meta+ArrowRight', 1], ['Meta+ArrowUp', -1], ['Meta+ArrowLeft', -1],
      ['Meta+ArrowLeft', -1],
    ] as const) {
      await page.keyboard.press(key);
      at = (at + step + order.length) % order.length;
      await expectOnScreen(page, order[at]);
    }
  });

  test('works with the focus outside the terminal too', async ({ page, home }) => {
    const order = await openThree(page, home);
    const at = order.indexOf(S.loginFix);
    await blurAll(page);
    await page.keyboard.press('Meta+Shift+BracketRight');
    await expectOnScreen(page, order[(at + 1) % order.length]);
  });

  test('skips a session whose process has ended', async ({ page, home }) => {
    const order = await openThree(page, home);
    const at = order.indexOf(S.loginFix);
    const skipped = order[(at + 1) % order.length];
    // Ended in the background: the terminal stays, with its exit banner.
    await fakeClaude(home, skipped).exit(0);
    await expect.poll(async () => (await terminalState(page, skipped)).closed).toBe(true);
    await expectOnScreen(page, S.loginFix);

    await page.keyboard.press('Meta+Shift+BracketRight');
    await expectOnScreen(page, order[(at + 2) % order.length]);
  });

  test('with no session on screen, goes to the first open one', async ({ page, home }) => {
    const order = await openThree(page, home);
    // A click on the list's empty space puts the session away.
    await sidebar(page).getByText('Recent', { exact: true }).click();
    await expect(terminalHeader(page)).toBeHidden();
    await page.keyboard.press('Meta+Shift+BracketRight');
    await expectOnScreen(page, order[0]);
  });
});

test.describe('Cmd+A', () => {
  test('opens the picker, from the terminal or from nowhere', async ({ page, home }) => {
    await page.keyboard.press('Meta+a');
    await expect(picker(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);

    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(terminalInput(page)).toBeFocused();
    await page.keyboard.press('Meta+a');
    await expect(picker(page)).toHaveCount(1);
  });

  test('is Select All in a text field', async ({ page }) => {
    await searchBox(page).fill('billing');
    await searchBox(page).press('Meta+a');
    await expect(picker(page)).toHaveCount(0);
    expect(await searchBox(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([0, 'billing'.length]);
  });
});

test.describe('Cmd+E', () => {
  test('archives the open session', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+e');
    await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({ archived: 1 });
  });

  test('archives it with the focus outside the terminal too', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await blurAll(page);
    await page.keyboard.press('Meta+e');
    await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({ archived: 1 });
  });

  test('is left alone in a text field', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await searchBox(page).focus();
    await page.keyboard.press('Meta+e');
    await page.waitForTimeout(800);
    expect(await storedSession(page, S.loginFix)).toMatchObject({ archived: 0 });
  });
});

test.describe('quick session, with a folder set', () => {
  test.use({ fixture: { ...standardFixture(), settings: { quickSessionPath: '/tmp' } } });

  async function expectQuickLaunch(home: FixtureHome, before: Set<string>): Promise<void> {
    const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(fs.realpathSync(launch.cwd)).toBe(fs.realpathSync('/tmp'));
  }

  test('Cmd+N starts one, once, from the terminal', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(terminalInput(page)).toBeFocused();
    const before = launchedKeys(home);
    await page.keyboard.press('Meta+n');
    await expectQuickLaunch(home, before);
    // One keypress, one session: the document listener stepped aside.
    await page.waitForTimeout(1000);
    expect(launchedKeys(home).size).toBe(before.size + 1);
  });

  test('a bare N starts one outside the terminal and text fields', async ({ page, home }) => {
    await blurAll(page);
    const before = launchedKeys(home);
    await page.keyboard.press('n');
    await expectQuickLaunch(home, before);
  });

  test('a bare N in the terminal is typed, not a shortcut', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const before = launchedKeys(home);
    await page.keyboard.press('n');
    await claude.waitForInput('n');
    await page.waitForTimeout(800);
    expect(launchedKeys(home)).toEqual(before);
  });

  test('a bare N in a text field is typed, and N with a modifier does nothing', async ({ page, home }) => {
    const before = launchedKeys(home);
    await searchBox(page).focus();
    await page.keyboard.press('n');
    await expect(searchBox(page)).toHaveValue('n');
    await blurAll(page);
    for (const key of ['Shift+n', 'Control+n', 'Alt+n']) await page.keyboard.press(key);
    await page.waitForTimeout(800);
    expect(launchedKeys(home)).toEqual(before);
  });
});

test.describe('quick session, with no folder set', () => {
  test('Cmd+N opens global settings instead', async ({ page }) => {
    await page.keyboard.press('Meta+n');
    await expect(globalSettings(page)).toBeVisible();
  });

  test('so does a bare N', async ({ page }) => {
    await blurAll(page);
    await page.keyboard.press('n');
    await expect(globalSettings(page)).toBeVisible();
  });
});

test.describe('no double firing', () => {
  test('a session-navigation key in the terminal moves exactly one step', async ({ page, home }) => {
    const order = await openThree(page, home);
    const at = order.indexOf(S.loginFix);
    await expect(terminalInput(page)).toBeFocused();
    await page.keyboard.press('Meta+ArrowDown');
    await expectOnScreen(page, order[(at + 1) % order.length]);
    await page.waitForTimeout(300);
    await expectOnScreen(page, order[(at + 1) % order.length]);
  });

  test('Cmd+L in the terminal puts the cursor on the open row, once', async ({ page, home }) => {
    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await expect(terminalInput(page)).toBeFocused();
    await page.keyboard.press('Meta+l');
    await expect(listScroller(page)).toBeFocused();
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);
  });
});
