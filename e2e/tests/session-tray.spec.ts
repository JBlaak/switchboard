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
