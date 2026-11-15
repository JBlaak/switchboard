/**
 * The terminal host, its search bar and its header (#60): how a terminal is
 * built and kept, what the output does to the screen, and the bar and tray
 * above it.
 *
 * xterm runs in the renderer, so all of this is the renderer's: a session's
 * output is pushed as main pushes it (component/support/terminal-session.ts),
 * what the terminal sends comes back as `sendInput`, and what xterm draws is
 * read through the renderer's test probe (e2e/support/terminal.ts). Typing
 * through to the real process and dropping real files (whose paths only
 * Electron can resolve) stay in e2e/tests/terminal-host.spec.ts, with the
 * search bar's screenshot.
 *
 * The rules that do not need xterm are unit tested: how output is batched and
 * held for a synchronized update (test/terminal-write-buffer.test.ts), which
 * keys are translated (test/terminal-input.test.ts), OSC 52 decoding
 * (test/clipboard-osc52.test.ts) and the header's state
 * (test/terminal-slice.test.ts).
 */
import {test, expect, openSession} from '../support/terminal-session';
import type {FakeClaude, FakeSessions} from '../support/terminal-session';
import {openSessionTray, sessionRow, sessionTray, sidebar, terminalHeader, terminalStatus} from '../../e2e/support/app';
import {answerDialogs} from '../../e2e/support/native-dialogs';
import {
    cellPoint,
    expectTerminalText,
    findInTerminal,
    scrollTerminal,
    selectInTerminal,
    terminalLines,
    terminalState,
    terminalText,
} from '../../e2e/support/terminal';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {DEFAULT_TRENDING} from '../../src/domain/bugsnag/connection';
import type {Page} from '@playwright/test';

/** `count` numbered lines, enough to push the first ones into scrollback. */
function numbered(prefix: string, count: number): string[] {
    return Array.from({length: count}, (_, i) => `${prefix} ${i + 1}`);
}

/** Wait until the terminal has caught up with everything written, then a little longer. */
async function settle(page: Page, ms = 150): Promise<void> {
    await page.waitForTimeout(ms);
}

/**
 * Push what is printed next below the top of the terminal, where resting the
 * pointer opens the session tray over it.
 */
async function belowTrayBand(claude: FakeClaude): Promise<void> {
    await claude.println(...Array<string>(10).fill(''));
}

function searchInput(page: Page) {
    return page.getByPlaceholder('Find...');
}

test.describe('terminal host', () => {
    test('a hidden terminal keeps its container and its output', async ({page, sessions}) => {
        /* Given */
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        await claude.println('output from the first session');
        await expectTerminalText(page, S.loginFix, 'output from the first session');
        await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('.terminal-container.visible') as HTMLElement & {
                e2eTag?: string;
            };
            el.e2eTag = 'first';
        });

        /* When */
        await openSession(page, sessions, LABEL.chartsDarkMode, S.chartsDarkMode);

        /* Then */
        expect((await terminalState(page, S.loginFix)).visible).toBe(false);
        expect((await terminalState(page, S.chartsDarkMode)).visible).toBe(true);
        // Hidden, not unmounted: the buffer is all still there.
        expect(await terminalText(page, S.loginFix)).toContain('output from the first session');

        /* When */
        await sessionRow(page, LABEL.loginFix).click();

        /* Then */
        await expect.poll(async () => (await terminalState(page, S.loginFix)).visible).toBe(true);
        const tag = await page.evaluate(
            () =>
                (document.querySelector<HTMLElement>('.terminal-container.visible') as HTMLElement & {e2eTag?: string})
                    .e2eTag,
        );
        expect(tag).toBe('first');
        // Brought forward, not relaunched.
        expect(sessions.launches(S.loginFix)).toBe(1);
    });

    test('each terminal is built with the house options and follows the colour scheme', async ({page, sessions}) => {
        /* Given */
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);

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
        // What main's setAppearance('dark') does: the window's colour scheme turns dark.
        await page.emulateMedia({colorScheme: 'dark'});

        /* Then */
        await expect.poll(async () => (await terminalState(page, S.loginFix)).background).toBe('#141517');
    });

    test('plain URLs and OSC 8 links open in the browser', async ({page, api, sessions}) => {
        /* Given */
        api.answer('openExternal', undefined);
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        await belowTrayBand(claude);
        await claude.println('See https://example.com/docs for more');
        await claude.println('\x1b]8;;https://example.com/osc8\x07an OSC 8 link\x1b]8;;\x07');
        await expectTerminalText(page, S.loginFix, 'an OSC 8 link');

        for (const [text, url] of [
            ['https://example.com/docs', 'https://example.com/docs'],
            ['an OSC 8 link', 'https://example.com/osc8'],
        ]) {
            /* When */
            const at = await findInTerminal(page, S.loginFix, text);
            const point = await cellPoint(page, S.loginFix, at.column + 3, at.viewportRow);
            // The link is found on hover, then activated by the click.
            await page.mouse.move(point.x, point.y);
            await page.mouse.move(point.x + 1, point.y);

            /* Then */
            await expect
                .poll(
                    async () => {
                        await page.mouse.click(point.x + 1, point.y);
                        return api.callsTo('openExternal').map(([opened]) => opened);
                    },
                    {message: `${url} to open`},
                )
                .toContain(url);
        }
    });

    test('clicking a `! command` types it at the prompt, so it runs in the session', async ({page, sessions}) => {
        /* Given */
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        await belowTrayBand(claude);
        // Inline code the way the CLI draws it: no backticks, a colour of its own.
        await claude.println(
            'To push, run \x1b[38;2;177;185;249m! git push -u origin nohrd-faq-sync\x1b[39m in the prompt.',
        );
        await expectTerminalText(page, S.loginFix, 'in the prompt.');

        /* When */
        const at = await findInTerminal(page, S.loginFix, '! git push');
        const point = await cellPoint(page, S.loginFix, at.column + 6, at.viewportRow);
        // Hovered until xterm finds the link and shows the pointer, then clicked once.
        await expect
            .poll(
                async () => {
                    await page.mouse.move(point.x, point.y);
                    await page.mouse.move(point.x + 1, point.y);
                    return page.locator('.terminal-container.visible .xterm-cursor-pointer').count();
                },
                {message: 'the command to be a link'},
            )
            .toBe(1);
        await page.mouse.click(point.x + 1, point.y);

        /* Then */
        await claude.waitForInput('\r');
        expect(claude.input()).toBe('!git push -u origin nohrd-faq-sync\r');
    });
});

test.describe('terminal input', () => {
    test('OSC 52 writes the clipboard and refuses read-back', async ({page, api, sessions}) => {
        /* Given */
        api.answer('writeClipboard', undefined);
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        const clipboardWrites = () => api.callsTo('writeClipboard').map(([text]) => text);

        /* When */
        await claude.print(`\x1b]52;c;${Buffer.from('copied from the terminal').toString('base64')}\x07`);

        /* Then */
        await expect.poll(clipboardWrites).toEqual(['copied from the terminal']);

        /* When */
        // A read-back query is consumed and never answered.
        await claude.print('\x1b]52;c;?\x07');
        await settle(page);
        await page.keyboard.type('x');

        /* Then */
        await claude.waitForInput('x');
        expect(claude.input()).toBe('x');
        expect(clipboardWrites()).toEqual(['copied from the terminal']);
    });
});

test.describe('terminal scrolling and resize', () => {
    test('output and a refit keep a terminal at the bottom, and leave a scrolled-up one where it is', async ({
        page,
        sessions,
    }) => {
        /* Given */
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);

        /* When */
        await claude.println(...numbered('line', 120));

        /* Then */
        await expectTerminalText(page, S.loginFix, 'line 120');
        await expect
            .poll(async () => {
                const {viewportY, baseY} = await terminalState(page, S.loginFix);
                return baseY > 0 && viewportY === baseY;
            })
            .toBe(true);

        /* When */
        const before = await terminalState(page, S.loginFix);
        // The window's content shrinks, as dragging its edge would.
        await page.setViewportSize({width: 1100, height: 650});

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

    test('the terminal refits at the end of a sidebar resize, and when settings close', async ({
        page,
        api,
        sessions,
    }) => {
        /* Given */
        // What the settings page asks main for.
        api.answer('getShellProfiles', [{id: 'auto', name: 'Auto', path: '/bin/zsh'}]);
        api.answer('getAppVersion', '9.0.0');
        api.answer('quickAskHotkeyStatus', {registered: true, missing: []});
        api.answer('bugsnagConnection', {
            tokenLastFour: null,
            status: null,
            projects: [],
            localProjects: [],
            trending: DEFAULT_TRENDING,
            mcpMissing: false,
        });
        await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        // The first fit follows the route a frame after the session shows; read
        // the width before it and the terminal still reports xterm's default 80.
        await settle(page);
        const initial = await terminalState(page, S.loginFix);
        const box = (await sidebar(page).boundingBox())!;

        /* When */
        await page.mouse.move(box.x + box.width + 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width + 120, box.y + box.height / 2, {steps: 5});
        await page.mouse.up();

        /* Then */
        await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(initial.cols);

        /* When */
        const before = await terminalState(page, S.loginFix);
        await page.getByRole('button', {name: 'Global settings', exact: true}).click();
        await page.getByRole('menuitem', {name: 'All settings…'}).click();
        await expect(page.getByText('Global Settings', {exact: true})).toBeVisible();
        // Hidden behind settings, the terminal cannot measure itself.
        await page.setViewportSize({width: 1100, height: 650});
        await settle(page, 300);

        /* Then */
        expect((await terminalState(page, S.loginFix)).cols).toBe(before.cols);

        /* When */
        await page.getByRole('button', {name: 'Cancel', exact: true}).click();

        /* Then */
        await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(before.cols);
    });
});

test.describe('terminal exit and stop', () => {
    test('an exited Claude session keeps its terminal until its row is clicked again', async ({page, sessions}) => {
        /* Given */
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        const stop = (await openSessionTray(page)).getByRole('button', {name: 'Stop session', exact: true});
        await expect(stop).toBeEnabled();

        /* When */
        await claude.exit(3);

        /* Then */
        await expectTerminalText(page, S.loginFix, 'session exited (code 3)');
        await expect(terminalStatus(page)).toHaveText('Stopped');
        await expect(stop).toBeDisabled();
        expect(await terminalState(page, S.loginFix)).toMatchObject({visible: true, closed: true});

        /* When */
        await sessionRow(page, LABEL.loginFix).click();

        /* Then */
        await expect.poll(() => sessions.launches(S.loginFix)).toBe(2);
        await expect(terminalStatus(page)).toHaveText('Running');
        // A fresh terminal: the old one, banner and all, was torn down.
        await expect.poll(async () => (await terminalState(page, S.loginFix)).closed).toBe(false);
        expect(await terminalText(page, S.loginFix)).not.toContain('session exited');
    });

    test('the Stop button asks first, and confirming stops the session and clears the screen', async ({
        page,
        api,
        sessions,
    }) => {
        /* Given */
        await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        const stop = sessionTray(page).getByRole('button', {name: 'Stop session', exact: true});

        /* When */
        await answerDialogs(page, false);
        await openSessionTray(page);
        await stop.click();
        await settle(page, 300);

        /* Then */
        await expect(terminalStatus(page)).toHaveText('Running');
        expect(api.callsTo('stopSession')).toEqual([]);
        expect(sessions.isRunning(S.loginFix)).toBe(true);

        /* When */
        await answerDialogs(page, true);
        await page.mouse.move(600, 600);
        await openSessionTray(page);
        await stop.click();

        /* Then */
        await expect(terminalHeader(page)).toBeHidden();
        expect(api.callsTo('stopSession')).toEqual([[S.loginFix]]);
        await expect.poll(() => page.evaluate(() => window.api.getActiveSessions())).not.toContain(S.loginFix);
    });
});

test.describe('terminal search', () => {
    async function withNeedles(page: Page, sessions: FakeSessions): Promise<FakeClaude> {
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        await claude.println('first needle here', 'nothing', 'second needle here', 'nothing', 'third needle here');
        await expectTerminalText(page, S.loginFix, 'third needle here');
        return claude;
    }

    async function matchRow(page: Page): Promise<number | undefined> {
        const state = await terminalState(page, S.loginFix);
        return state.selection === 'needle' ? state.selectionStart?.y : undefined;
    }

    test('Cmd+F opens the bar focused, typing finds, and Escape or × close it and give the terminal the keyboard', async ({
        page,
        sessions,
    }) => {
        /* Given */
        const claude = await withNeedles(page, sessions);
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
        await page.getByRole('button', {name: '×', exact: true}).click();
        await page.keyboard.type('yy');

        /* Then */
        await expect(searchInput(page)).toBeHidden();
        await claude.waitForInput('yy');
    });

    test('a selection is pre-filled, and Enter, Shift+Enter and the buttons step through the matches', async ({
        page,
        sessions,
    }) => {
        /* Given */
        await withNeedles(page, sessions);
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
        await page.getByRole('button', {name: '▼', exact: true}).click();

        /* Then */
        await expect.poll(() => matchRow(page)).toBe(second.row);

        /* When */
        await page.getByRole('button', {name: '▲', exact: true}).click();

        /* Then */
        await expect.poll(() => matchRow(page)).toBe(first.row);
    });
});

test.describe('session tray, hover zone', () => {
    test('hovering the top of the terminal opens the tray, lower down does not', async ({page, sessions}) => {
        /* Given */
        await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        const box = await page.locator('#terminals').boundingBox();
        if (!box) throw new Error('no terminal on screen');
        const x = box.x + box.width / 2;

        /* When */
        await page.mouse.move(x, box.y + 160);
        await settle(page, 300);

        /* Then */
        await expect(sessionTray(page)).not.toHaveClass(/is-open/);

        /* When */
        await page.mouse.move(x, box.y + 50);

        /* Then */
        await expect(sessionTray(page)).toHaveClass(/is-open/);

        /* When */
        await page.mouse.move(x, box.y + box.height - 20);

        /* Then */
        await expect(sessionTray(page)).not.toHaveClass(/is-open/);
    });
});
