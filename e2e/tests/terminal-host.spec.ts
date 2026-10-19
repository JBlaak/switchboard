/**
 * The terminal host, its search bar and its header (#60): how a terminal is
 * built and kept, what reaches the process, what the output does to the
 * screen, and the bar above it.
 *
 * What xterm draws is read through the renderer's test probe (see
 * e2e/support/terminal.ts); what the terminal sends is read off the fake
 * `claude`, which logs every byte it receives.
 *
 * The rules that do not need xterm are unit tested: how output is batched and
 * held for a synchronized update (test/terminal-write-buffer.test.ts), which
 * keys are translated (test/terminal-input.test.ts), OSC 52 decoding
 * (test/clipboard-osc52.test.ts) and the header's state
 * (test/terminal-slice.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sessionRow, sidebar, terminalHeader, terminalStatus } from '../support/app';
import { clipboardWrites, openedExternally } from '../support/main-process';
import { answerDialogs } from '../support/native-dialogs';
import {
  cellPoint, expectTerminalText, findInTerminal, scrollTerminal, selectInTerminal, terminalLines, terminalState,
  terminalText,
} from '../support/terminal';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import { posixQuote } from '../../src/domain/shell/quoting';
import type { ElectronApplication, Page } from '@playwright/test';

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
    BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('/quick-ask/'))!
      .setContentSize(size.width, size.height);
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
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println('output from the first session');
    await expectTerminalText(page, S.loginFix, 'output from the first session');
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.terminal-container.visible') as HTMLElement & { e2eTag?: string };
      el.e2eTag = 'first';
    });

    /* When */
    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);

    /* Then */
    expect((await terminalState(page, S.loginFix)).visible).toBe(false);
    expect((await terminalState(page, S.chartsDarkMode)).visible).toBe(true);
    // Hidden, not unmounted: the buffer is all still there.
    expect(await terminalText(page, S.loginFix)).toContain('output from the first session');

    /* When */
    await sessionRow(page, LABEL.loginFix).click();

    /* Then */
    await expect.poll(async () => (await terminalState(page, S.loginFix)).visible).toBe(true);
    const tag = await page.evaluate(() =>
      (document.querySelector<HTMLElement>('.terminal-container.visible') as HTMLElement & { e2eTag?: string }).e2eTag);
    expect(tag).toBe('first');
    // Brought forward, not relaunched.
    expect(claude.launches()).toHaveLength(1);
  });

  test('each terminal is built with the house options and follows the colour scheme', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    // convertEol: a bare \n returns the carriage too.
    await claude.print('left\nright\r\n');

    /* Then */
    expect(await terminalState(page, S.loginFix)).toMatchObject({
      scrollback: 10000,
      convertEol: true,
      macOptionClickForcesSelection: true,
      hasLinkHandler: true,
      unicodeVersion: '15',
      renderer: 'webgl',
      background: '#fafbfd',
    });
    await expect.poll(() => terminalLines(page, S.loginFix)).toContain('right');

    /* When */
    await page.evaluate(() => window.api.setAppearance('dark'));

    /* Then */
    await expect.poll(async () => (await terminalState(page, S.loginFix)).background).toBe('#141517');
  });

  test('plain URLs and OSC 8 links open in the browser', async ({ page, home, app }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println('See https://example.com/docs for more');
    await claude.println('\x1b]8;;https://example.com/osc8\x07an OSC 8 link\x1b]8;;\x07');
    await expectTerminalText(page, S.loginFix, 'an OSC 8 link');

    for (const [text, url] of [['https://example.com/docs', 'https://example.com/docs'], ['an OSC 8 link', 'https://example.com/osc8']]) {
      /* When */
      const at = await findInTerminal(page, S.loginFix, text);
      const point = await cellPoint(page, S.loginFix, at.column + 3, at.viewportRow);
      // The link is found on hover, then activated by the click.
      await page.mouse.move(point.x, point.y);
      await page.mouse.move(point.x + 1, point.y);

      /* Then */
      await expect.poll(async () => {
        await page.mouse.click(point.x + 1, point.y);
        return openedExternally(app);
      }, { message: `${url} to open` }).toContain(url);
    }
  });
});

test.describe('terminal input', () => {
  test('typing reaches the process, without focus reports, with kitty Enter sequences and Space on keydown', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    // Ask for focus reporting, as a TUI does.
    await claude.print('\x1b[?1004h');
    await settle(page);

    /* When */
    // Focus leaves the terminal and comes back: neither is reported.
    await page.getByPlaceholder('Search sessions...').click();
    await clickTerminal(page, S.loginFix);
    await page.keyboard.type('after focus');

    /* Then */
    await claude.waitForInput('after focus');
    expect(claude.input()).toBe('after focus');

    /* When */
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Control+Enter');
    await page.keyboard.type('x');

    /* Then */
    // Kitty sequences, and no stray newline after them.
    await claude.waitForInput('x');
    expect(claude.input()).toBe('after focus\x1b[13;2u\x1b[13;5ux');

    /* When */
    // Held down: the second and third keydowns are repeats.
    await page.keyboard.down('Space');
    await page.keyboard.down('Space');
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await page.keyboard.type('y');

    /* Then */
    await claude.waitForInput('y');
    expect(claude.input()).toBe('after focus\x1b[13;2u\x1b[13;5ux   y');

    /* When */
    // Space during IME composition is left to the composer.
    await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', isComposing: true, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { get: () => 229 });
      document.activeElement!.dispatchEvent(event);
    });
    await page.keyboard.type('z');

    /* Then */
    await claude.waitForInput('z');
    expect(claude.input()).toBe('after focus\x1b[13;2u\x1b[13;5ux   yz');
  });

  test('OSC 52 writes the clipboard and refuses read-back', async ({ page, home, app }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await claude.print(`\x1b]52;c;${Buffer.from('copied from the terminal').toString('base64')}\x07`);

    /* Then */
    await expect.poll(() => clipboardWrites(app)).toEqual(['copied from the terminal']);

    /* When */
    // A read-back query is consumed and never answered.
    await claude.print('\x1b]52;c;?\x07');
    await settle(page);
    await page.keyboard.type('x');

    /* Then */
    await claude.waitForInput('x');
    expect(claude.input()).toBe('x');
    expect(await clipboardWrites(app)).toEqual(['copied from the terminal']);
  });

  test('dropped files are sent as quoted paths, with a counted drag highlight', async ({ page, home }) => {
    /* Given */
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

    /* When */
    // Entering a child counts as another enter, so one leave is not enough to clear it.
    await drag('dragenter');
    await drag('dragenter');

    /* Then */
    expect((await terminalState(page, S.loginFix)).dragOver).toBe(true);

    /* When */
    await drag('dragleave');

    /* Then */
    expect((await terminalState(page, S.loginFix)).dragOver).toBe(true);

    /* When */
    await drag('dragleave');

    /* Then */
    expect((await terminalState(page, S.loginFix)).dragOver).toBe(false);

    /* When */
    await drag('dragenter');
    await drag('drop');

    /* Then */
    expect((await terminalState(page, S.loginFix)).dragOver).toBe(false);
    const expected = files.map(posixQuote).join(' ');
    await claude.waitForInput(expected);
    expect(claude.input()).toBe(expected);
  });
});

test.describe('terminal scrolling and resize', () => {
  test('output and a refit keep a terminal at the bottom, and leave a scrolled-up one where it is', async ({ page, home, app }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await claude.println(...numbered('line', 120));

    /* Then */
    await expectTerminalText(page, S.loginFix, 'line 120');
    await expect.poll(async () => {
      const { viewportY, baseY } = await terminalState(page, S.loginFix);
      return baseY > 0 && viewportY === baseY;
    }).toBe(true);

    /* When */
    const before = await terminalState(page, S.loginFix);
    await setContentSize(app, 1100, 650);

    /* Then */
    await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(before.cols);
    const refitted = await terminalState(page, S.loginFix);
    expect(refitted.rows).toBeLessThan(before.rows);
    expect(refitted.viewportY).toBe(refitted.baseY);

    /* When */
    await scrollTerminal(page, S.loginFix, -30);
    const scrolledTo = (await terminalState(page, S.loginFix)).viewportY;
    await claude.println(...numbered('more', 40));
    await expectTerminalText(page, S.loginFix, 'more 40');
    await settle(page);

    /* Then */
    const after = await terminalState(page, S.loginFix);
    expect(after.viewportY).toBe(scrolledTo);
    expect(after.baseY).toBeGreaterThan(after.viewportY);
  });

  test('the terminal refits at the end of a sidebar resize, and when settings close', async ({ page, home, app }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const initial = await terminalState(page, S.loginFix);
    const box = (await sidebar(page).boundingBox())!;

    /* When */
    await page.mouse.move(box.x + box.width + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 120, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    /* Then */
    await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(initial.cols);

    /* When */
    const before = await terminalState(page, S.loginFix);
    await page.getByRole('button', { name: 'Global settings', exact: true }).click();
    await expect(page.getByText('Global Settings', { exact: true })).toBeVisible();
    // Hidden behind settings, the terminal cannot measure itself.
    await setContentSize(app, 1100, 650);
    await settle(page, 300);

    /* Then */
    expect((await terminalState(page, S.loginFix)).cols).toBe(before.cols);

    /* When */
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    /* Then */
    await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(before.cols);
  });
});

test.describe('terminal exit and stop', () => {
  test('an exited Claude session keeps its terminal until its row is clicked again', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const stop = terminalHeader(page).getByRole('button', { name: 'Stop process', exact: true });
    await expect(stop).toBeVisible();

    /* When */
    await claude.exit(3);

    /* Then */
    await expectTerminalText(page, S.loginFix, 'session exited (code 3)');
    await expect(terminalStatus(page)).toHaveText('Stopped');
    await expect(stop).toBeHidden();
    expect(await terminalState(page, S.loginFix)).toMatchObject({ visible: true, closed: true });

    /* When */
    await sessionRow(page, LABEL.loginFix).click();

    /* Then */
    await claude.waitForLaunchCount(2);
    await expect(terminalStatus(page)).toHaveText('Running');
    // A fresh terminal: the old one, banner and all, was torn down.
    await expect.poll(async () => (await terminalState(page, S.loginFix)).closed).toBe(false);
    expect(await terminalText(page, S.loginFix)).not.toContain('session exited');
  });

  test('the Stop button asks first, and confirming stops the session and clears the screen', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const stop = terminalHeader(page).getByRole('button', { name: 'Stop process', exact: true });

    /* When */
    await answerDialogs(page, false);
    await stop.click();
    await settle(page, 300);

    /* Then */
    await expect(terminalStatus(page)).toHaveText('Running');
    expect(await page.evaluate(() => window.api.getActiveSessions())).toContain(S.loginFix);

    /* When */
    await answerDialogs(page, true);
    await stop.click();

    /* Then */
    await expect(terminalHeader(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.api.getActiveSessions())).not.toContain(S.loginFix);
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

  test('Cmd+F opens the bar focused, typing finds, and Escape or × close it and give the terminal the keyboard', async ({ page, home }) => {
    /* Given */
    const claude = await withNeedles(page, home);
    await expect(searchInput(page)).toBeHidden();

    /* When */
    await page.keyboard.press('Meta+f');

    /* Then */
    await expect(searchInput(page)).toBeVisible();
    await expect(searchInput(page)).toBeFocused();
    await expect(searchInput(page)).toHaveValue('');

    /* When */
    await searchInput(page).pressSequentially('needle');

    /* Then */
    await expect.poll(() => matchRow(page)).not.toBeUndefined();

    /* When */
    await searchInput(page).press('Escape');
    await page.keyboard.type('zz');

    /* Then */
    await expect(searchInput(page)).toBeHidden();
    await claude.waitForInput('zz');

    /* When */
    await page.keyboard.press('Meta+f');

    /* Then */
    // Escape cleared it.
    await expect(searchInput(page)).toHaveValue('');

    /* When */
    await searchInput(page).pressSequentially('needle');
    await page.getByRole('button', { name: '×', exact: true }).click();
    await page.keyboard.type('yy');

    /* Then */
    await expect(searchInput(page)).toBeHidden();
    await claude.waitForInput('yy');
  });

  test('a selection is pre-filled, and Enter, Shift+Enter and the buttons step through the matches', async ({ page, home }) => {
    /* Given */
    await withNeedles(page, home);
    const first = await findInTerminal(page, S.loginFix, 'first needle');
    const second = await findInTerminal(page, S.loginFix, 'second needle');
    await selectInTerminal(page, S.loginFix, first.column + 'first '.length, first.row, 'needle'.length);

    /* When */
    await page.keyboard.press('Meta+f');

    /* Then */
    await expect(searchInput(page)).toHaveValue('needle');
    // The search starts at the selection, so it is the current match and the
    // next one is a step away.
    await expect.poll(() => matchRow(page)).toBe(first.row);

    /* When */
    await searchInput(page).press('Enter');

    /* Then */
    await expect.poll(() => matchRow(page)).toBe(second.row);

    /* When */
    await searchInput(page).press('Shift+Enter');

    /* Then */
    await expect.poll(() => matchRow(page)).toBe(first.row);

    /* When */
    await page.getByRole('button', { name: '▼', exact: true }).click();

    /* Then */
    await expect.poll(() => matchRow(page)).toBe(second.row);

    /* When */
    await page.getByRole('button', { name: '▲', exact: true }).click();

    /* Then */
    await expect.poll(() => matchRow(page)).toBe(first.row);
  });
});

test.describe('terminal header, shell profile', () => {
  test.use({ fixture: { ...standardFixture(), projectSettings: { [P.acmeApi]: { shellProfile: 'bash' } } } });

  test('only a session in a non-default shell names it', async ({ page, home }) => {
    /* When */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* Then */
    await expect(terminalHeader(page).getByText('Bash', { exact: true })).toBeVisible();

    /* When */
    // Its project has no shell profile of its own.
    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await settle(page, 300);

    /* Then */
    await expect(terminalHeader(page).getByText(/^(Auto|Zsh|Bash)$/)).toHaveCount(0);
  });
});

forEachAppearance(() => {
  test('terminal search bar, open', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.println('first needle here', 'second needle here');
    await expectTerminalText(page, S.loginFix, 'second needle here');

    /* When */
    await page.keyboard.press('Meta+f');
    await searchInput(page).pressSequentially('needle');

    /* Then */
    await expect.poll(async () => (await terminalState(page, S.loginFix)).selection).toBe('needle');
    await expectScreen(page, 'terminal-search');
  });
});
