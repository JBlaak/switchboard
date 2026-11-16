/**
 * The session list, wired to the real app: the blank space under a short list,
 * which drags the real window.
 *
 * Everything else the list does against main — statuses filing rows under
 * their sections, what a redraw leaves alone, where the keyboard goes, pin,
 * stop, snooze, archive and its motion, rename — is in
 * component/tests/session-list.spec.ts. The rules behind it are unit tested
 * against the pure layout and the session-list slice
 * (`test/session-list-layout.test.ts`, `test/session-list-slice.test.ts`,
 * `test/session-list-row-labels.test.ts`, `test/session-list-redraw.test.ts`).
 */
import {test, expect} from '../support/test';
import {openSession, sessionRow, terminalHeader} from '../support/app';
import {minutesAgo, sessionId} from '../support/fixture-home';
import {windowPosition} from '../support/main-process';
import {sessionItem} from '../support/session-list';
import {P} from '../fixtures/standard';
import type {FixtureSpec} from '../support/fixture-home';

/** A short list, so there is space left under it. */
function shortList(): FixtureSpec {
    return {
        projects: [
            {
                path: P.notes,
                sessions: [
                    {id: sessionId('short-1'), prompt: 'A short list, first', at: minutesAgo(5)},
                    {id: sessionId('short-2'), prompt: 'A short list, second', at: minutesAgo(15)},
                ],
            },
        ],
    };
}

// ── The space under the list ──

test.describe('under a short list', () => {
    test.use({fixture: shortList()});

    test('the empty space moves the window on a drag, and puts the session away on a click', async ({
        page,
        app,
        home,
    }) => {
        /* Given */
        await openSession(page, home, 'A short list, first', sessionId('short-1'));
        const space = page.getByTestId('sidebar-drag-space');
        const before = await windowPosition(app);

        /* When */
        // Dispatched by hand rather than with page.mouse: a real cursor's screenX
        // stays put as the window moves under it, a synthesized one's does not.
        await space.evaluate((space) => {
            const at = (type: string, screenX: number, screenY: number) =>
                space.dispatchEvent(new PointerEvent(type, {bubbles: true, button: 0, pointerId: 7, screenX, screenY}));
            at('pointerdown', 500, 500);
            at('pointermove', 502, 501);
            at('pointermove', 520, 510);
            at('pointermove', 540, 530);
            at('pointerup', 540, 530);
        });
        await space.dispatchEvent('click');

        /* Then */
        await expect.poll(() => windowPosition(app)).toEqual([before[0]! + 40, before[1]! + 30]);
        // A drag ends in no click, so the session stays on screen.
        await expect(terminalHeader(page)).toBeVisible();
        const box = (await space.boundingBox())!;
        const footer = (await page.getByTestId('sidebar-footer').boundingBox())!;
        expect(box.height).toBeGreaterThan(100);
        // It runs down to the footer, less the list's bottom padding.
        expect(Math.abs(box.y + box.height - footer.y)).toBeLessThanOrEqual(12);
        // Not a CSS drag region: macOS would swallow the click that puts the session away.
        expect(await space.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).not.toBe(
            'drag',
        );

        /* When */
        await sessionRow(page, 'A short list, second').hover();
        await sessionItem(page, sessionId('short-2')).getByTestId('session-pin').click();

        /* Then */
        await expect(terminalHeader(page)).toBeVisible();

        /* When */
        // A press that barely moves is still a click.
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 2, y + 1);
        await page.mouse.up();

        /* Then */
        await expect(page.getByTestId('empty-screen')).toBeVisible();
        await expect(terminalHeader(page)).toBeHidden();
        await expect(sessionItem(page, sessionId('short-1'))).not.toHaveClass(/\bactive\b/);
    });
});
