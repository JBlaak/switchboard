/**
 * The terminal host, its search bar and its header (#60): how a terminal is
 * built and kept, what reaches the process, what the output does to the
 * screen, and the bar above it.
 *
 * What xterm draws is read through the renderer's test probe (see
 * e2e/support/terminal.ts); what the terminal sends is read off the fake
 * `claude`, which logs every byte it receives.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sessionRow, sidebar, terminalHeader, terminalStatus } from '../support/app';
import { clipboardWrites, openedExternally } from '../support/main-process';
import {
  cellPoint, expectTerminalText, findInTerminal, scrollTerminal, selectInTerminal, terminalLines, terminalState,
  terminalText,
} from '../support/terminal';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import { posixQuote } from '../../src/domain/shell/quoting';
import type { ElectronApplication, Page } from '@playwright/test';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

/** `count` numbered lines, enough to push the first ones into scrollback. */
function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

/** Wait until the terminal has caught up with everything written, then a little longer. */
async function settle(page: Page, ms = 150): Promise<void> {
  await page.waitForTimeout(ms);
}

async function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
  }, { width, height });
}

/** Click into the terminal grid, which focuses it. */
async function clickTerminal(page: Page, sessionId: string): Promise<void> {
  const point = await cellPoint(page, sessionId, 10, 5);
  await page.mouse.click(point.x, point.y);
}

function searchInput(page: Page) {
  return page.getByPlaceholder('Find...');
}

test.describe('terminal host', () => {
  test('a hidden terminal keeps its container and its output', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println('output from the first session');
    await expectTerminalText(page, S.loginFix, 'output from the first session');
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.terminal-container.visible') as HTMLElement & { e2eTag?: string };
      el.e2eTag = 'first';
    });

    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    expect((await terminalState(page, S.loginFix)).visible).toBe(false);
    expect((await terminalState(page, S.chartsDarkMode)).visible).toBe(true);
    // Hidden, not unmounted: the buffer is all still there.
    expect(await terminalText(page, S.loginFix)).toContain('output from the first session');

    await sessionRow(page, LABEL.loginFix).click();
    await expect.poll(async () => (await terminalState(page, S.loginFix)).visible).toBe(true);
    const tag = await page.evaluate(() =>
      (document.querySelector<HTMLElement>('.terminal-container.visible') as HTMLElement & { e2eTag?: string }).e2eTag);
    expect(tag).toBe('first');
    // Brought forward, not relaunched.
    expect(claude.launches()).toHaveLength(1);
  });

  test('each terminal is built with the house options and addons', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    expect(await terminalState(page, S.loginFix)).toMatchObject({
      scrollback: 10000,
      convertEol: true,
      macOptionClickForcesSelection: true,
      hasLinkHandler: true,
      unicodeVersion: '15',
      renderer: 'webgl',
    });
    // convertEol: a bare \n returns the carriage too.
    await claude.print('left\nright\r\n');
    await expect.poll(() => terminalLines(page, S.loginFix)).toContain('right');
  });

  test('plain URLs and OSC 8 links open in the browser', async ({ page, home, app }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println('See https://example.com/docs for more');
    await claude.println('\x1b]8;;https://example.com/osc8\x07an OSC 8 link\x1b]8;;\x07');
    await expectTerminalText(page, S.loginFix, 'an OSC 8 link');

    for (const [text, url] of [['https://example.com/docs', 'https://example.com/docs'], ['an OSC 8 link', 'https://example.com/osc8']]) {
      const at = await findInTerminal(page, S.loginFix, text);
      const point = await cellPoint(page, S.loginFix, at.column + 3, at.viewportRow);
      // The link is found on hover, then activated by the click.
      await page.mouse.move(point.x, point.y);
      await page.mouse.move(point.x + 1, point.y);
      await expect.poll(async () => {
        await page.mouse.click(point.x + 1, point.y);
        return openedExternally(app);
      }, { message: `${url} to open` }).toContain(url);
    }
  });
});

test.describe('terminal output', () => {
  test('a synchronized update is held until it ends', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.print(SYNC_START + 'repaint part one\r\n');
    await settle(page);
    expect(await terminalText(page, S.loginFix)).not.toContain('repaint part one');

    await claude.print('repaint part two\r\n' + SYNC_END);
    await expectTerminalText(page, S.loginFix, 'repaint part two');
    expect(await terminalText(page, S.loginFix)).toContain('repaint part one');
  });

  test('nested synchronized updates are held until the outer one ends', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.print(SYNC_START + 'outer\r\n');
    await claude.print(SYNC_START + 'inner\r\n');
    await claude.print(SYNC_END);
    await settle(page);
    expect(await terminalText(page, S.loginFix)).not.toContain('outer');

    await claude.print(SYNC_END);
    await expectTerminalText(page, S.loginFix, 'inner');
  });

  test('an unclosed synchronized update is written after 500ms', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.print(SYNC_START + 'never closed\r\n');
    const sent = Date.now();
    await settle(page, 200);
    expect(await terminalText(page, S.loginFix)).not.toContain('never closed');
    await expectTerminalText(page, S.loginFix, 'never closed');
    expect(Date.now() - sent).toBeGreaterThanOrEqual(400);
  });

  test('output keeps a terminal at the bottom pinned there', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println(...numbered('line', 120));
    await expectTerminalText(page, S.loginFix, 'line 120');
    await expect.poll(async () => {
      const { viewportY, baseY } = await terminalState(page, S.loginFix);
      return baseY > 0 && viewportY === baseY;
    }).toBe(true);
  });

  test('output leaves a scrolled-up terminal where it is', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println(...numbered('line', 120));
    await expectTerminalText(page, S.loginFix, 'line 120');
    await scrollTerminal(page, S.loginFix, -30);
    const before = (await terminalState(page, S.loginFix)).viewportY;

    await claude.println(...numbered('more', 40));
    await expectTerminalText(page, S.loginFix, 'more 40');
    await settle(page);
    const after = await terminalState(page, S.loginFix);
    expect(after.viewportY).toBe(before);
    expect(after.baseY).toBeGreaterThan(after.viewportY);
  });
});

test.describe('terminal input', () => {
  test('focus reports are not sent to the process', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    // Ask for focus reporting, as a TUI does.
    await claude.print('\x1b[?1004h');
    await settle(page);
    await page.getByPlaceholder('Search sessions...').click();
    await clickTerminal(page, S.loginFix);
    await page.keyboard.type('after focus');
    await claude.waitForInput('after focus');
    expect(claude.input()).toBe('after focus');
  });

  test('Shift+Enter and Ctrl+Enter send kitty sequences, and no stray newline', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Control+Enter');
    await page.keyboard.type('x');
    await claude.waitForInput('x');
    expect(claude.input()).toBe('\x1b[13;2u\x1b[13;5ux');
  });

  test('Space is sent on keydown, key repeat included', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    // Held down: the second and third keydowns are repeats.
    await page.keyboard.down('Space');
    await page.keyboard.down('Space');
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await page.keyboard.type('x');
    await claude.waitForInput('x');
    expect(claude.input()).toBe('   x');
  });

  test('Space during IME composition is left to the composer', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', isComposing: true, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { get: () => 229 });
      document.activeElement!.dispatchEvent(event);
    });
    await page.keyboard.type('x');
    await claude.waitForInput('x');
    expect(claude.input()).toBe('x');
  });

  test('OSC 52 writes the clipboard and refuses read-back', async ({ page, home, app }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.print(`\x1b]52;c;${Buffer.from('copied from the terminal').toString('base64')}\x07`);
    await expect.poll(() => clipboardWrites(app)).toEqual(['copied from the terminal']);

    // A read-back query is consumed and never answered.
    await claude.print('\x1b]52;c;?\x07');
    await settle(page);
    await page.keyboard.type('x');
    await claude.waitForInput('x');
    expect(claude.input()).toBe('x');
    expect(await clipboardWrites(app)).toEqual(['copied from the terminal']);
  });

  test('dropped files are sent as quoted paths, with a counted drag highlight', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const dir = path.join(home.home, 'Drop zone');
    fs.mkdirSync(dir, { recursive: true });
    const files = [path.join(dir, "Bob's notes.txt"), path.join(dir, 'plain.txt')];
    for (const file of files) fs.writeFileSync(file, 'x');

    // Real File objects, so the app can resolve their paths on disk.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.id = 'e2e-drop-files';
      input.style.display = 'none';
      document.body.appendChild(input);
    });
    await page.setInputFiles('#e2e-drop-files', files);

    const point = await cellPoint(page, S.loginFix, 10, 5);
    const drag = (type: string) => page.evaluate(([type, x, y]) => {
      const transfer = new DataTransfer();
      if (type === 'drop') {
        for (const file of (document.getElementById('e2e-drop-files') as HTMLInputElement).files!) transfer.items.add(file);
      }
      const target = document.elementFromPoint(x as number, y as number)!;
      target.dispatchEvent(new DragEvent(type as string, { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, [type, point.x, point.y]);

    // Entering a child counts as another enter, so one leave is not enough to clear it.
    await drag('dragenter');
    await drag('dragenter');
    expect((await terminalState(page, S.loginFix)).dragOver).toBe(true);
    await drag('dragleave');
    expect((await terminalState(page, S.loginFix)).dragOver).toBe(true);
    await drag('dragleave');
    expect((await terminalState(page, S.loginFix)).dragOver).toBe(false);

    await drag('dragenter');
    await drag('drop');
    expect((await terminalState(page, S.loginFix)).dragOver).toBe(false);
    const expected = files.map(posixQuote).join(' ');
    await claude.waitForInput(expected);
    expect(claude.input()).toBe(expected);
  });
});

test.describe('terminal resize', () => {
  test('the terminal refits to the window and stays at the bottom', async ({ page, home, app }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println(...numbered('line', 120));
    await expectTerminalText(page, S.loginFix, 'line 120');
    const before = await terminalState(page, S.loginFix);

    await setContentSize(app, 1100, 650);
    await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(before.cols);
    const after = await terminalState(page, S.loginFix);
    expect(after.rows).toBeLessThan(before.rows);
    expect(after.viewportY).toBe(after.baseY);
  });

  test('the terminal refits at the end of a sidebar resize', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const before = await terminalState(page, S.loginFix);
    const box = (await sidebar(page).boundingBox())!;
    await page.mouse.move(box.x + box.width + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 120, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(before.cols);
  });

  test('terminals refit when settings close', async ({ page, home, app }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const before = await terminalState(page, S.loginFix);
    await page.getByRole('button', { name: 'Global settings', exact: true }).click();
    await expect(page.getByText('Global Settings — Global', { exact: true })).toBeVisible();
    // Hidden behind settings, the terminal cannot measure itself.
    await setContentSize(app, 1100, 650);
    await settle(page, 300);
    expect((await terminalState(page, S.loginFix)).cols).toBe(before.cols);

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(before.cols);
  });
});

test.describe('terminal theme and exit', () => {
  test('the terminal follows the colour scheme', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    expect((await terminalState(page, S.loginFix)).background).toBe('#fafbfd');
    await page.evaluate(() => window.api.setAppearance('dark'));
    await expect.poll(async () => (await terminalState(page, S.loginFix)).background).toBe('#141517');
  });

  test('an exited Claude session keeps its terminal until its row is clicked again', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.exit(3);
    await expectTerminalText(page, S.loginFix, 'session exited (code 3)');
    await expect(terminalStatus(page)).toHaveText('Stopped');
    expect(await terminalState(page, S.loginFix)).toMatchObject({ visible: true, closed: true });

    await sessionRow(page, LABEL.loginFix).click();
    await claude.waitForLaunchCount(2);
    await expect(terminalStatus(page)).toHaveText('Running');
    // A fresh terminal: the old one, banner and all, was torn down.
    await expect.poll(async () => (await terminalState(page, S.loginFix)).closed).toBe(false);
    expect(await terminalText(page, S.loginFix)).not.toContain('session exited');
  });
});

test.describe('terminal search', () => {
  async function withNeedles(page: Page, home: Parameters<typeof openSession>[1]) {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println('first needle here', 'nothing', 'second needle here', 'nothing', 'third needle here');
    await expectTerminalText(page, S.loginFix, 'third needle here');
    return claude;
  }

  async function matchRow(page: Page): Promise<number | undefined> {
    const state = await terminalState(page, S.loginFix);
    return state.selection === 'needle' ? state.selectionStart?.y : undefined;
  }

  test('Cmd+F opens the bar with the input focused', async ({ page, home }) => {
    await withNeedles(page, home);
    await expect(searchInput(page)).toBeHidden();
    await page.keyboard.press('Meta+f');
    await expect(searchInput(page)).toBeVisible();
    await expect(searchInput(page)).toBeFocused();
    await expect(searchInput(page)).toHaveValue('');
  });

  test('a selection is pre-filled and searched for', async ({ page, home }) => {
    await withNeedles(page, home);
    const first = await findInTerminal(page, S.loginFix, 'first needle');
    await selectInTerminal(page, S.loginFix, first.column + 'first '.length, first.row, 'needle'.length);
    await page.keyboard.press('Meta+f');
    await expect(searchInput(page)).toHaveValue('needle');
    // The search starts at the selection, so it is the current match and the
    // next one is a step away.
    await expect.poll(() => matchRow(page)).toBe(first.row);
    await searchInput(page).press('Enter');
    const second = await findInTerminal(page, S.loginFix, 'second needle');
    await expect.poll(() => matchRow(page)).toBe(second.row);
  });

  test('typing finds, Enter and Shift+Enter step through, and so do the buttons', async ({ page, home }) => {
    await withNeedles(page, home);
    const rows = await Promise.all(['first needle', 'second needle', 'third needle']
      .map(async text => (await findInTerminal(page, S.loginFix, text)).row));

    await page.keyboard.press('Meta+f');
    await searchInput(page).pressSequentially('needle');
    await expect.poll(() => matchRow(page)).not.toBeUndefined();
    const start = rows.indexOf((await matchRow(page))!);
    expect(start).toBeGreaterThanOrEqual(0);
    const at = (step: number) => rows[(start + step + rows.length * 2) % rows.length];

    await searchInput(page).press('Enter');
    await expect.poll(() => matchRow(page)).toBe(at(1));
    await searchInput(page).press('Shift+Enter');
    await expect.poll(() => matchRow(page)).toBe(at(0));

    await page.getByRole('button', { name: '▼', exact: true }).click();
    await expect.poll(() => matchRow(page)).toBe(at(1));
    await page.getByRole('button', { name: '▲', exact: true }).click();
    await expect.poll(() => matchRow(page)).toBe(at(0));
  });

  test('Escape closes the bar, clears it and gives the terminal the keyboard', async ({ page, home }) => {
    const claude = await withNeedles(page, home);
    await page.keyboard.press('Meta+f');
    await searchInput(page).pressSequentially('needle');
    await searchInput(page).press('Escape');
    await expect(searchInput(page)).toBeHidden();
    await page.keyboard.type('zz');
    await claude.waitForInput('zz');

    await page.keyboard.press('Meta+f');
    await expect(searchInput(page)).toHaveValue('');
  });

  test('the × button closes the bar and gives the terminal the keyboard', async ({ page, home }) => {
    const claude = await withNeedles(page, home);
    await page.keyboard.press('Meta+f');
    await searchInput(page).pressSequentially('needle');
    await page.getByRole('button', { name: '×', exact: true }).click();
    await expect(searchInput(page)).toBeHidden();
    await page.keyboard.type('zz');
    await claude.waitForInput('zz');
  });
});

test.describe('terminal header', () => {
  test('a notification replaces the title, for the session on screen only', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.idle('Claude Code');
    await expect(terminalHeader(page).getByText('✳ Claude Code', { exact: true })).toBeVisible();
    await claude.notify('Claude needs your permission to use Bash');
    await expect(terminalHeader(page).getByText('Claude needs your permission to use Bash', { exact: true })).toBeVisible();
    await expect(terminalHeader(page).getByText('✳ Claude Code', { exact: true })).toHaveCount(0);

    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await claude.notify('A message for the other session');
    await settle(page);
    await expect(terminalHeader(page).getByText('A message for the other session')).toHaveCount(0);
  });

  test('no shell profile is named for the default one', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await settle(page, 300);
    await expect(terminalHeader(page).getByText(/^(Auto|Zsh|Bash)$/)).toHaveCount(0);
  });

  test('the Stop button asks first, and goes once the process has', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const stop = terminalHeader(page).getByRole('button', { name: 'Stop process', exact: true });
    await expect(stop).toBeVisible();

    page.once('dialog', dialog => void dialog.dismiss());
    await stop.click();
    await settle(page, 300);
    await expect(terminalStatus(page)).toHaveText('Running');
    expect(await page.evaluate(() => window.api.getActiveSessions())).toContain(S.loginFix);

    await claude.exit(0);
    await expect(terminalStatus(page)).toHaveText('Stopped');
    await expect(stop).toBeHidden();
  });

  test('confirming Stop stops the session and clears the screen', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    page.once('dialog', dialog => void dialog.accept());
    await terminalHeader(page).getByRole('button', { name: 'Stop process', exact: true }).click();
    await expect(terminalHeader(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.api.getActiveSessions())).not.toContain(S.loginFix);
  });

  test('the header is a window drag region whose controls opt out', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const region = (locator: ReturnType<typeof terminalHeader>) =>
      locator.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
    expect(await region(terminalHeader(page))).toBe('drag');
    expect(await region(terminalHeader(page).getByRole('button', { name: 'Stop process', exact: true }))).toBe('no-drag');
    expect(await region(terminalHeader(page).getByText(LABEL.loginFix, { exact: true }))).toBe('no-drag');
    expect(await region(terminalHeader(page).getByText(S.loginFix, { exact: true }))).toBe('no-drag');
  });
});

test.describe('terminal header, shell profile', () => {
  test.use({ fixture: { ...standardFixture(), projectSettings: { [P.acmeApi]: { shellProfile: 'bash' } } } });

  test('a session in a non-default shell names it', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(terminalHeader(page).getByText('Bash', { exact: true })).toBeVisible();
  });
});

forEachAppearance(() => {
  test('terminal search bar, open', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println('first needle here', 'second needle here');
    await expectTerminalText(page, S.loginFix, 'second needle here');
    await page.keyboard.press('Meta+f');
    await searchInput(page).pressSequentially('needle');
    await expect.poll(async () => (await terminalState(page, S.loginFix)).selection).toBe('needle');
    await expectScreen(page, 'terminal-search');
  });
});
