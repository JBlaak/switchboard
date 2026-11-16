/**
 * The session tray (#343) over a real window: the tray stays open wherever
 * the pointer is on the slimmed bar, and the bar still moves the window.
 *
 * The tray against what main answers (hovering it open over the terminal
 * without resizing it, ⌘1 typing a saved prompt, holding ⌘, a tray with more
 * rows than fit) is in component/tests/session-tray.spec.ts.
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
    // Both ends and the middle of the bar, near its top and bottom edges, as a real pointer reaches them.
    const points = [0.02, 0.5, 0.98].flatMap((fx) =>
        [0.1, 0.9].map((fy) => ({x: box.x + box.width * fx, y: box.y + box.height * fy})),
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
