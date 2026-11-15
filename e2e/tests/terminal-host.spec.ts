/**
 * The terminal host against the real process: what typing and dropping files
 * deliver to it, and the shell a session's project runs in.
 *
 * What the terminal sends is read off the fake `claude`, which logs every byte
 * it receives; a dropped file's path is resolved by Electron (webUtils) from a
 * real file on disk; and the shell named in the session tray is the profile
 * main resolves from the project's settings. What xterm draws is read through
 * the renderer's test probe (see e2e/support/terminal.ts).
 *
 * The rest of the terminal host is the renderer's and is tested in the
 * component suite (component/tests/terminal-host.spec.ts): the hidden
 * terminal, the house options, links, `! command`, OSC 52, scrolling and
 * refits, exit and Stop, the search bar and the tray's hover zone.
 *
 * The rules that do not need xterm are unit tested: how output is batched and
 * held for a synchronized update (test/terminal-write-buffer.test.ts), which
 * keys are translated (test/terminal-input.test.ts), OSC 52 decoding
 * (test/clipboard-osc52.test.ts) and the header's state
 * (test/terminal-slice.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import {test, expect} from '../support/test';
import {openSession, openSessionTray} from '../support/app';
import {cellPoint, terminalState} from '../support/terminal';
import {LABEL, P, S, standardFixture} from '../fixtures/standard';
import {posixQuote} from '../../src/domain/shell/quoting';
import type {Page} from '@playwright/test';

/** Wait until the terminal has caught up with everything written, then a little longer. */
async function settle(page: Page, ms = 150): Promise<void> {
    await page.waitForTimeout(ms);
}

/** Click into the terminal grid, which focuses it. */
async function clickTerminal(page: Page, sessionId: string): Promise<void> {
    const point = await cellPoint(page, sessionId, 10, 5);
    await page.mouse.click(point.x, point.y);
}

test.describe('terminal input', () => {
    test('typing reaches the process, without focus reports, with kitty Enter sequences and Space on keydown', async ({
        page,
        home,
    }) => {
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
            const event = new KeyboardEvent('keydown', {
                key: ' ',
                code: 'Space',
                isComposing: true,
                bubbles: true,
                cancelable: true,
            });
            Object.defineProperty(event, 'keyCode', {get: () => 229});
            document.activeElement!.dispatchEvent(event);
        });
        await page.keyboard.type('z');

        /* Then */
        await claude.waitForInput('z');
        expect(claude.input()).toBe('after focus\x1b[13;2u\x1b[13;5ux   yz');
    });

    test('dropped files are sent as quoted paths, with a counted drag highlight', async ({page, home}) => {
        /* Given */
        const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
        const dir = path.join(home.home, 'Drop zone');
        fs.mkdirSync(dir, {recursive: true});
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
        const drag = (type: string) =>
            page.evaluate(
                ([type, x, y]) => {
                    const transfer = new DataTransfer();
                    if (type === 'drop') {
                        for (const file of (document.getElementById('e2e-drop-files') as HTMLInputElement).files!)
                            transfer.items.add(file);
                    }
                    const target = document.elementFromPoint(x as number, y as number)!;
                    target.dispatchEvent(
                        new DragEvent(type as string, {dataTransfer: transfer, bubbles: true, cancelable: true}),
                    );
                },
                [type, point.x, point.y],
            );

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

test.describe('session tray, shell profile', () => {
    test.use({fixture: {...standardFixture(), projectSettings: {[P.acmeApi]: {shellProfile: 'bash'}}}});

    test('only a session in a non-default shell names it', async ({page, home}) => {
        /* When */
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* Then */
        // On the tray's Session meta line (#343): shell · running time · messages.
        await expect((await openSessionTray(page)).locator('.tray-meta')).toContainText(/^Bash · /);

        /* When */
        // Its project has no shell profile of its own.
        await page.mouse.move(600, 600);
        await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
        await settle(page, 300);

        /* Then */
        await expect((await openSessionTray(page)).locator('.tray-meta')).not.toContainText(/Auto|Zsh|Bash/);
    });
});
