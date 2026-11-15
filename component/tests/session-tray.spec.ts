/**
 * The session tray (#343): hovering the slimmed bar drops the tray over the
 * terminal without resizing it, holding ⌘ shows it, and ⌘1 types the first
 * saved prompt into the session.
 *
 * Main is played by answering `savedPrompts` with the stored list, as its
 * settings service reads it, and the terminal's size is what the renderer
 * last sent main (`resizeTerminal`), which is what the e2e fake `claude`'s
 * pty reported. The bar moving the real window stays in
 * e2e/tests/session-tray.spec.ts.
 */
import {test, expect} from '../support/test';
import {terminalHeader} from '../../e2e/support/app';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {openSession, waitForInput} from '../support/running-session';
import {parseSavedPrompts} from '../../src/domain/settings/saved-prompts';
import type {FakeApi} from '../support/fake-api';
import type {Answers} from '../support/default-answers';

const PROMPT = 'Where are we on this?';

/** Main's answers for these saved prompts, stored globally. */
function withSavedPrompts(prompts: unknown[]): Answers {
    return {savedPrompts: {global: parseSavedPrompts(prompts), project: []}};
}

/** The terminal's size as main last heard it, or null before the first fit. */
function ptySize(api: FakeApi, sessionId: string): {cols: number; rows: number} | null {
    const last = api
        .callsTo('resizeTerminal')
        .filter(([id]) => id === sessionId)
        .at(-1);
    return last ? {cols: last[1], rows: last[2]} : null;
}

test.use({answers: withSavedPrompts([{id: 'where', label: 'Where are we?', text: PROMPT, mode: 'send'}])});

test('hovering the bar opens the tray over the terminal, and ⌘1 types a saved prompt into it', async ({page, api}) => {
    /* Given */
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    const size = () => ptySize(api, S.loginFix);
    const tray = page.getByRole('region', {name: 'Session tools'});
    await expect(tray).not.toHaveClass(/is-open/);
    await expect.poll(size).not.toBeNull();
    // The first fit can still be followed by a refit as the window settles: wait until it holds.
    await expect
        .poll(async () => {
            const before = JSON.stringify(size());
            await page.waitForTimeout(300);
            return JSON.stringify(size()) === before;
        })
        .toBe(true);
    const sizeBefore = size();

    /* When */
    await terminalHeader(page).getByText(LABEL.loginFix, {exact: true}).hover();

    /* Then */
    await expect(tray).toHaveClass(/is-open/);
    await expect(tray.getByRole('button', {name: 'Send: Where are we?'})).toContainText('⌘1');
    await expect(tray.getByRole('button', {name: 'Copy session id'})).toBeVisible();
    // The tray lies over the terminal: the pty keeps its size.
    expect(size()).toEqual(sizeBefore);

    /* When */
    await page.mouse.move(600, 600);
    await expect(tray).not.toHaveClass(/is-open/);
    await page.keyboard.press('Meta+1');

    /* Then */
    await waitForInput(api, S.loginFix, PROMPT);
    await waitForInput(api, S.loginFix, PROMPT + '\x1b[201~\r');
    await expect(tray).toHaveClass(/is-open/);
    await expect(tray.getByRole('button', {name: 'Send: Where are we?'})).toContainText('Sent ✓');
    await expect(tray).not.toHaveClass(/is-open/);
    expect(size()).toEqual(sizeBefore);
});

test('holding ⌘ shows the tray after 150 ms, letting go hides it, and a quick ⌘ shortcut never does', async ({
    page,
    api,
}) => {
    /* Given */
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    const tray = page.getByRole('region', {name: 'Session tools'});
    await page.mouse.move(600, 600);
    await expect(tray).not.toHaveClass(/is-open/);
    // When the tray's class turns open, from the moment ⌘ goes down.
    await page.evaluate(() => {
        const w = window as unknown as {cmdDownAt?: number; trayOpenAt?: number};
        window.addEventListener('keydown', (e) => (e.key === 'Meta' ? (w.cmdDownAt = performance.now()) : 0), true);
        const el = document.querySelector('.session-tray');
        new MutationObserver(() => {
            if (el?.classList.contains('is-open') && w.trayOpenAt === undefined) w.trayOpenAt = performance.now();
        }).observe(el!, {attributes: true, attributeFilter: ['class']});
    });

    /* When */
    await page.keyboard.down('Meta');

    /* Then */
    await expect(tray).toHaveClass(/is-open/);
    await expect(tray.getByRole('button', {name: 'Send: Where are we?'})).toContainText('⌘1');
    const waited = await page.evaluate(() => {
        const w = window as unknown as {cmdDownAt: number; trayOpenAt: number};
        return w.trayOpenAt - w.cmdDownAt;
    });
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(400);

    /* When */
    await page.keyboard.up('Meta');

    /* Then */
    await expect(tray).not.toHaveClass(/is-open/);

    /* When */
    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyK');
    await page.waitForTimeout(300);

    /* Then */
    await expect(tray).not.toHaveClass(/is-open/);
    await page.keyboard.up('Meta');
});

test.describe('a tray with more rows than fit', () => {
    const many = Array.from({length: 14}, (_, i) => ({
        id: 'p' + i,
        label: 'Prompt ' + (i + 1),
        text: 'Prompt text ' + (i + 1),
        mode: 'send' as const,
    }));
    test.use({answers: withSavedPrompts(many)});

    test('keeps the tray the same height and scrolls the group inside its card', async ({page, api}) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        const tray = page.getByRole('region', {name: 'Session tools'});

        /* When */
        await terminalHeader(page).getByText(LABEL.loginFix, {exact: true}).hover();
        await expect(tray).toHaveClass(/is-open/);

        /* Then */
        expect((await tray.boundingBox())?.height).toBe(240);
        const bodies = tray.locator('.tray-card-body');
        const overflow = await bodies.evaluateAll((els) =>
            els.map((el) => ({group: el.parentElement!.className, more: el.scrollHeight > el.clientHeight})),
        );
        expect(overflow).toEqual([
            {group: expect.stringContaining('tray-ask'), more: true},
            {group: expect.stringContaining('tray-links'), more: false},
            {group: expect.stringContaining('tray-workspace'), more: false},
        ]);
        const session = tray.locator('.tray-session');
        expect(await session.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);

        /* When */
        const last = tray.getByRole('button', {name: 'Send: Prompt 14'});
        await bodies.first().hover();
        await page.mouse.wheel(0, 1000);

        /* Then */
        await expect(last).toBeInViewport();
        await expect(tray).toHaveClass(/is-open/);
        expect((await tray.boundingBox())?.height).toBe(240);
    });
});
