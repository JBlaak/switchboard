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

test('holding ⌘ shows the tray after 150 ms, letting go hides it, and a quick ⌘ shortcut never does', async ({
    page,
    home,
}) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
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
    console.log(`tray opened ${Math.round(waited)} ms after ⌘ went down`);
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

test('the tray stays open with the pointer anywhere over the bar, and the bar still moves the window', async ({
    page,
    app,
    home,
}) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const tray = page.getByRole('region', {name: 'Session tools'});
    const header = terminalHeader(page);
    await header.getByText(LABEL.loginFix, {exact: true}).hover();
    await expect(tray).toHaveClass(/is-open/);
    const box = (await header.boundingBox())!;
    // Every point of the bar on a grid, edge to edge, as a real pointer reaches it.
    const points = [0.02, 0.15, 0.3, 0.45, 0.5, 0.55, 0.7, 0.85, 0.98].flatMap((fx) =>
        [0.1, 0.5, 0.9].map((fy) => ({x: box.x + box.width * fx, y: box.y + box.height * fy})),
    );

    /* When */
    const dragRegions = await page.evaluate(
        (pts) =>
            pts.filter(({x, y}) => {
                // A CSS drag region never hands the page a pointer event on a real Mac, though a
                // synthetic one gets through: so no point of the bar may lie in one.
                for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
                    const region = getComputedStyle(el).getPropertyValue('-webkit-app-region');
                    if (region === 'no-drag') return false;
                    if (region === 'drag') return true;
                }
                return false;
            }),
        points,
    );

    /* Then */
    expect(dragRegions).toEqual([]);

    /* When */
    for (const {x, y} of points) {
        await page.mouse.move(x, y, {steps: 2});
        // Past the tray's leave grace, so a point that counted as leaving would have closed it.
        await page.waitForTimeout(300);

        /* Then */
        await expect(tray, `pointer at ${Math.round(x)},${Math.round(y)}`).toHaveClass(/is-open/);
    }

    /* Given */
    const windowAt = (): Promise<number[]> =>
        app.evaluate(({BrowserWindow}) =>
            BrowserWindow.getAllWindows()
                .find((w) => w.getTitle() === 'Switchboard')!
                .getPosition(),
        );
    const before = await windowAt();
    // Playwright's mouse leaves screenX/Y unset, and the window follows those: so a press
    // that carries them, as a real one does.
    const pressAndDrag = (at: {x: number; y: number}): Promise<void> =>
        page.evaluate(({x, y}) => {
            const target = document.elementFromPoint(x, y)!;
            const fire = (type: string, dx: number, dy: number, buttons: number): void => {
                target.dispatchEvent(
                    new PointerEvent(type, {
                        bubbles: true,
                        pointerId: 1,
                        button: 0,
                        buttons,
                        clientX: x + dx,
                        clientY: y + dy,
                        screenX: 500 + dx,
                        screenY: 300 + dy,
                    }),
                );
            };
            fire('pointerdown', 0, 0, 1);
            fire('pointermove', 20, 15, 1);
            fire('pointermove', 40, 30, 1);
            fire('pointerup', 40, 30, 0);
        }, at);
    const name = (await header.getByText(LABEL.loginFix, {exact: true}).boundingBox())!;

    /* When */
    await pressAndDrag({x: name.x + name.width / 2, y: name.y + name.height / 2});

    /* Then */
    // The name keeps its press, for selecting it.
    await page.waitForTimeout(300);
    expect(await windowAt()).toEqual(before);

    /* When */
    await pressAndDrag({x: box.x + box.width * 0.5, y: box.y + box.height * 0.5});

    /* Then */
    await expect.poll(windowAt).toEqual([before[0] + 40, before[1] + 30]);
    await expect(tray).toHaveClass(/is-open/);
});
