/**
 * The session tray (#343): hovering the slimmed bar drops the tray over a
 * real terminal without resizing it, and ⌘1 types the first saved prompt into
 * the session.
 */
import {test, expect} from '../support/test';
import {openSession, terminalHeader} from '../support/app';
import {LABEL, S, standardFixture} from '../fixtures/standard';

const PROMPT = 'Where are we on this?';

test.use({
    fixture: {
        ...standardFixture(),
        settings: {savedPrompts: [{id: 'where', label: 'Where are we?', text: PROMPT, mode: 'send'}]},
    },
});

test('hovering the bar opens the tray over the terminal, and ⌘1 types a saved prompt into it', async ({page, home}) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const tray = page.getByRole('region', {name: 'Session tools'});
    await expect(tray).not.toHaveClass(/is-open/);
    await expect.poll(() => claude.size()).not.toBeNull();
    // The first fit can still be followed by a refit as the window settles: wait until it holds.
    await expect
        .poll(async () => {
            const before = JSON.stringify(claude.size());
            await page.waitForTimeout(300);
            return JSON.stringify(claude.size()) === before;
        })
        .toBe(true);
    const sizeBefore = claude.size();

    /* When */
    await terminalHeader(page).getByText(LABEL.loginFix, {exact: true}).hover();

    /* Then */
    await expect(tray).toHaveClass(/is-open/);
    await expect(tray.getByRole('button', {name: 'Send: Where are we?'})).toContainText('⌘1');
    await expect(tray.getByRole('button', {name: 'Copy session id'})).toBeVisible();
    // The tray lies over the terminal: the pty keeps its size.
    expect(claude.size()).toEqual(sizeBefore);

    /* When */
    await page.mouse.move(600, 600);
    await expect(tray).not.toHaveClass(/is-open/);
    await page.keyboard.press('Meta+1');

    /* Then */
    await claude.waitForInput(PROMPT);
    await claude.waitForInput(PROMPT + '\x1b[201~\r');
    await expect(tray).toHaveClass(/is-open/);
    await expect(tray.getByRole('button', {name: 'Send: Where are we?'})).toContainText('Sent ✓');
    await expect(tray).not.toHaveClass(/is-open/);
    expect(claude.size()).toEqual(sizeBefore);
});

test.describe('a tray with more rows than fit', () => {
    const many = Array.from({length: 14}, (_, i) => ({
        id: 'p' + i,
        label: 'Prompt ' + (i + 1),
        text: 'Prompt text ' + (i + 1),
        mode: 'send' as const,
    }));
    test.use({fixture: {...standardFixture(), settings: {savedPrompts: many}}});

    test('keeps the tray the same height and scrolls the group inside its card', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
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
