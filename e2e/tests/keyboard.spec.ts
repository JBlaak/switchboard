/**
 * The keyboard, end to end: walking the session list with a cursor, and the
 * shortcuts that work wherever the focus is — moving between open sessions,
 * the picker, archiving, quick sessions — without one keypress firing twice
 * when it passes through the terminal on its way.
 *
 * What each key means, and where the cursor or the next session goes, is
 * decided without the app and tested in node (`test/keyboard-shortcuts`,
 * `test/list-cursor`, `test/session-navigation`). These keep what only the
 * real app can show: the focus moving between the list, the terminal and the
 * page, the keys that pass through xterm, and what main does with the result.
 * Renaming from the cursor, and what the cursor survives, are in
 * `session-list.spec.ts`; Cmd+L on a collapsed sidebar is in `toolbar.spec.ts`.
 */
import fs from 'node:fs';
import { test, expect } from '../support/test';
import {
  dialog, openSession, searchBox, sessionRow, sidebar, terminalHeader,
} from '../support/app';
import { fakeClaude, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { minutesAgo, sessionId } from '../support/fixture-home';
import {
  keyboardCursor, listScroller, renameInput, sessionItem, storedSession,
} from '../support/session-list';
import { LABEL, S, standardFixture } from '../fixtures/standard';
import type { Page } from '@playwright/test';
import type { FixtureHome, FixtureSpec } from '../support/fixture-home';

/** The terminal's keyboard target: xterm's hidden textarea. */
function terminalInput(page: Page) {
  return page.getByRole('textbox', { name: 'Terminal input' });
}

const picker = (page: Page) => dialog(page, 'Projects');
const globalSettings = (page: Page) => page.getByText('Global Settings', { exact: true });

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

/** The session ids of these rows, sorted by where they sit on screen. */
async function onScreenOrder(page: Page, ids: readonly string[]): Promise<string[]> {
  const placed = await Promise.all(ids.map(async id => ({ id, y: (await sessionItem(page, id).boundingBox())!.y })));
  return placed.sort((a, b) => a.y - b.y).map(p => p.id);
}

// ── The list's cursor ──

test.describe('the list cursor', () => {
  test('the list takes the keyboard on Cmd+L only, and Esc with no session open lets go of it', async ({ page }) => {
    /* Given */
    await blurAll(page);

    /* When */
    for (const key of ['ArrowDown', 'j', 'e', 'a', 'r']) await page.keyboard.press(key);

    /* Then */
    await expect(keyboardCursor(page)).toHaveCount(0);
    await expect(picker(page)).toHaveCount(0);
    await expect(renameInput(page)).toHaveCount(0);

    /* When */
    await page.keyboard.press('Meta+l');

    /* Then */
    await expect(listScroller(page)).toBeFocused();
    await expect(keyboardCursor(page)).toHaveCount(1);
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(keyboardCursor(page)).toHaveCount(0);
    await expect(listScroller(page)).not.toBeFocused();
    await expect(sidebar(page).locator(':focus')).toHaveCount(0);
  });

  test('E archives a row or a whole group, Enter unfolds a group and opens a row', async ({ page, home }) => {
    /* Given */
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('j');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.loginFix);

    /* When */
    await page.keyboard.press('e');

    /* Then */
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);
    await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({ archived: 1 });
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);

    /* When */
    // The folded billing group's header is next; its rows are skipped.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    /* Then */
    await expect(keyboardCursor(page)).toContainText(LABEL.billingGroup);
    await expect(sessionRow(page, 'Plan how to move billing out of the monolith')).toBeVisible();

    /* When */
    await page.keyboard.press('ArrowDown');

    /* Then */
    // Unfolded, the group's rows are next in line.
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.billingStep2);

    /* When */
    // Back up to the header, and archive the group from there.
    await page.keyboard.press('k');
    await page.keyboard.press('e');

    /* Then */
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);
    for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
      await expect.poll(() => storedSession(page, id)).toMatchObject({ archived: 1 });
    }

    /* When */
    await page.keyboard.press('Enter');

    /* Then */
    await fakeClaude(home, S.chartsDarkMode).launched();
  });

  test('from the terminal, Cmd+L puts the cursor on the open row; leaving the list clears it, Esc hands the keyboard back', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await expect(terminalInput(page)).toBeFocused();

    /* When */
    await page.keyboard.press('Meta+l');

    /* Then */
    await expect(listScroller(page)).toBeFocused();
    await expect(keyboardCursor(page)).toHaveCount(1);
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);

    /* When */
    await page.keyboard.press('ArrowDown');
    await expect(keyboardCursor(page)).not.toHaveAttribute('data-session-id', S.chartsDarkMode);
    await searchBox(page).click();

    /* Then */
    await expect(keyboardCursor(page)).toHaveCount(0);

    /* When */
    // So the next Cmd+L starts over, on the open row again.
    await page.keyboard.press('Meta+l');

    /* Then */
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(keyboardCursor(page)).toHaveCount(0);
    await expect(terminalInput(page)).toBeFocused();
  });

  test.describe('on a long list', () => {
    test.use({ fixture: manySessions(40) });

    test('Cmd+L does not scroll to the open row; stepping scrolls only as far as it has to', async ({ page, home }) => {
      /* Given */
      await sessionRow(page, 'Long list session 20').scrollIntoViewIfNeeded();
      await openSession(page, home, 'Long list session 20', sessionId('many-19'));
      const before = await listScroller(page).evaluate(el => el.scrollTop);
      expect(before).toBeGreaterThan(0);

      /* When */
      await page.keyboard.press('Meta+l');

      /* Then */
      await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', sessionId('many-19'));
      expect(await listScroller(page).evaluate(el => el.scrollTop)).toBe(before);

      /* When */
      for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowDown');

      /* Then */
      const cursor = keyboardCursor(page);
      await expect(cursor).toHaveAttribute('data-session-id', sessionId('many-34'));
      // All of it, give or take a fraction of a pixel.
      await expect(cursor).toBeInViewport({ ratio: 0.95 });
      // "nearest": stepping down pulls the row up to the bottom edge, no further.
      const row = (await cursor.boundingBox())!;
      const list = (await listScroller(page).boundingBox())!;
      expect(Math.abs(row.y + row.height - (list.y + list.height))).toBeLessThanOrEqual(row.height);
      const top = await listScroller(page).evaluate(el => el.scrollTop);
      expect(top).toBeGreaterThan(before);

      /* When */
      // Stepping back up within the screen does not scroll at all.
      await page.keyboard.press('ArrowUp');

      /* Then */
      expect(await listScroller(page).evaluate(el => el.scrollTop)).toBe(top);
    });
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
  test('moves exactly one step from the terminal, and works with the focus outside it too', async ({ page, home }) => {
    /* Given */
    const order = await openThree(page, home);
    const at = order.indexOf(S.loginFix);
    await expect(terminalInput(page)).toBeFocused();

    /* When */
    await page.keyboard.press('Meta+ArrowDown');

    /* Then */
    await expectOnScreen(page, order[(at + 1) % order.length]);
    await page.waitForTimeout(300);
    await expectOnScreen(page, order[(at + 1) % order.length]);

    /* When */
    await blurAll(page);
    await page.keyboard.press('Meta+Shift+BracketRight');

    /* Then */
    await expectOnScreen(page, order[(at + 2) % order.length]);
  });
});

test.describe('Cmd+A', () => {
  test('opens the picker, from the terminal or from nowhere', async ({ page, home }) => {
    /* When */
    await page.keyboard.press('Meta+a');

    /* Then */
    await expect(picker(page)).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(picker(page)).toHaveCount(0);

    /* When */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(terminalInput(page)).toBeFocused();
    await page.keyboard.press('Meta+a');

    /* Then */
    await expect(picker(page)).toHaveCount(1);
  });
});

test.describe('Cmd+E', () => {
  test('archives the open session, from the terminal or with the focus outside it', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(terminalInput(page)).toBeFocused();

    /* When */
    await page.keyboard.press('Meta+e');

    /* Then */
    await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({ archived: 1 });

    /* When */
    await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    await blurAll(page);
    await page.keyboard.press('Meta+e');

    /* Then */
    await expect.poll(() => storedSession(page, S.worktreeTry)).toMatchObject({ archived: 1 });
  });
});

test.describe('quick session, with a folder set', () => {
  test.use({ fixture: { ...standardFixture(), settings: { quickSessionPath: '/tmp' } } });

  async function expectQuickLaunch(home: FixtureHome, before: Set<string>): Promise<void> {
    const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(fs.realpathSync(launch.cwd)).toBe(fs.realpathSync('/tmp'));
  }

  test('a bare N in the terminal is typed; Cmd+N there starts one, once; a bare N outside it starts one', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const opened = launchedKeys(home);

    /* When */
    await page.keyboard.press('n');

    /* Then */
    await claude.waitForInput('n');
    await page.waitForTimeout(800);
    expect(launchedKeys(home)).toEqual(opened);

    /* When */
    await page.keyboard.press('Meta+n');

    /* Then */
    await expectQuickLaunch(home, opened);
    // One keypress, one session: the document listener stepped aside.
    await page.waitForTimeout(1000);
    expect(launchedKeys(home).size).toBe(opened.size + 1);

    /* When */
    const quick = launchedKeys(home);
    await blurAll(page);
    await page.keyboard.press('n');

    /* Then */
    await expectQuickLaunch(home, quick);
  });
});

test.describe('quick session, with no folder set', () => {
  test('Cmd+N opens global settings instead', async ({ page }) => {
    /* When */
    await page.keyboard.press('Meta+n');

    /* Then */
    await expect(globalSettings(page)).toBeVisible();
  });
});
