/**
 * Trackpad gestures in the wired app (#374).
 *
 * The recognizer's rules are unit tested on recorded streams
 * (test/gesture-trackpad-swipe.test.ts), and where a swipe on the pane or a
 * question goes in test/session-navigation.test.ts,
 * test/question-panel-keys.test.ts and test/grill-keys.test.ts. This plays a
 * swipe as the wheel events macOS sends for it, one per frame, onto Claude's
 * pane or the question sheet, and checks it does what its twin does.
 * Dragging a pinned row into its place (#379) is a real mouse drag; the order
 * rules are test/pin-order.test.ts's and test/pin-moves.test.ts's.
 */
import {test, expect} from '../support/test';
import {openSession, sessionRow, terminalHeader, waitForIndex} from '../support/app';
import {expectRowsInOrder, keyboardCursor, sessionItem} from '../support/session-list';
import {launchApp} from '../support/launch';
import {askQuestions, questionPanel} from '../support/questions';
import {LABEL, S} from '../fixtures/standard';
import type {Locator, Page} from '@playwright/test';
import type {FixtureHome} from '../support/fixture-home';

/** One frame of a 60 Hz trackpad. */
const FRAME_MS = 16;

/**
 * Dispatch these wheel deltas on `target`, a frame apart, as a two-finger
 * swipe sends them; answers which of them were `preventDefault`ed.
 */
async function wheel(target: Locator, deltas: readonly [dx: number, dy: number][]): Promise<boolean[]> {
    return await target.evaluate(
        async (el, {deltas, frame}) => {
            const prevented: boolean[] = [];
            for (const [deltaX, deltaY] of deltas) {
                const event = new WheelEvent('wheel', {deltaX, deltaY, bubbles: true, cancelable: true});
                el.dispatchEvent(event);
                prevented.push(event.defaultPrevented);
                await new Promise((resolve) => setTimeout(resolve, frame));
            }
            return prevented;
        },
        {deltas, frame: FRAME_MS},
    );
}

/**
 * Dispatch these deltas as `wheel` does, but answer what the pane's swipe
 * label says right after the last of them, before the swipe is released.
 */
async function labelWhileSwiping(target: Locator, deltas: readonly [dx: number, dy: number][]): Promise<string | null> {
    return await target.evaluate(
        async (el, {deltas, frame}) => {
            for (const [deltaX, deltaY] of deltas) {
                el.dispatchEvent(new WheelEvent('wheel', {deltaX, deltaY, bubbles: true, cancelable: true}));
                await new Promise((resolve) => setTimeout(resolve, frame));
            }
            return (
                document.querySelector('.terminal-container.visible [data-testid="pane-swipe"]')?.textContent ?? null
            );
        },
        {deltas, frame: FRAME_MS},
    );
}

const repeat = (count: number, dx: number, dy = 0): [number, number][] => Array.from({length: count}, () => [dx, dy]);

// ── Claude's pane (#377) ──

/** Claude's output on screen: the xterm's own screen, under the viewport that stops the wheel bubbling. */
const pane = (page: Page): Locator => page.locator('.terminal-container.visible .xterm-screen');

const LABEL_OF: Record<string, string> = {
    [S.loginFix]: LABEL.loginFix,
    [S.worktreeTry]: LABEL.worktreeTry,
    [S.chartsDarkMode]: LABEL.chartsDarkMode,
};

/** Open three sessions and put the middle one, in sidebar order, on screen. Answers them in that order. */
async function middleOfThree(page: Page, home: FixtureHome): Promise<string[]> {
    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const ids = [S.loginFix, S.worktreeTry, S.chartsDarkMode];
    const placed = await Promise.all(ids.map(async (id) => ({id, y: (await sessionItem(page, id).boundingBox())!.y})));
    const order = placed.sort((a, b) => a.y - b.y).map((p) => p.id);
    await sessionRow(page, LABEL_OF[order[1]]).click();
    await expectOnScreen(page, order[1]);
    return order;
}

async function expectOnScreen(page: Page, id: string): Promise<void> {
    await expect(sessionItem(page, id)).toHaveClass(/\bactive\b/);
    await expect(terminalHeader(page)).toContainText(LABEL_OF[id]);
}

test('a sideways swipe on the pane goes to the next or previous session, in the order ⌘⇧] and ⌘⇧[ use', async ({
    page,
    home,
}) => {
    /* Given */
    const order = await middleOfThree(page, home);

    /* When: fingers moving left send a positive deltaX */
    const prevented = await wheel(pane(page), repeat(16, 20));

    /* Then */
    expect(prevented.slice(1).every(Boolean)).toBe(true);
    await expectOnScreen(page, order[2]);

    /* When */
    await page.waitForTimeout(300);
    await wheel(pane(page), repeat(16, -20));

    /* Then */
    await expectOnScreen(page, order[1]);
});

test('past the end of the list a swipe on the pane goes nowhere', async ({page, home}) => {
    /* Given */
    const order = await middleOfThree(page, home);
    await sessionRow(page, LABEL_OF[order[2]]).click();
    await expectOnScreen(page, order[2]);

    /* When */
    await wheel(pane(page), repeat(16, 20));
    await page.waitForTimeout(300);

    /* Then */
    await expectOnScreen(page, order[2]);
});

test('while a swipe on the pane tracks, the name of the session it goes to slides in', async ({page, home}) => {
    /* Given */
    const order = await middleOfThree(page, home);
    await page.emulateMedia({reducedMotion: 'no-preference'});

    /* When */
    const label = await labelWhileSwiping(pane(page), repeat(6, 14));

    /* Then */
    expect(label).toContain(LABEL_OF[order[2]]);
    await expectOnScreen(page, order[1]);
    await expect(page.getByTestId('pane-swipe')).toHaveCount(0);
});

test('a vertical scroll on the pane, drifting sideways, never changes session', async ({page, home}) => {
    /* Given */
    const order = await middleOfThree(page, home);

    /* When */
    const prevented = await wheel(pane(page), [...repeat(4, 0, 12), ...repeat(12, 10, 4)]);
    await page.waitForTimeout(300);

    /* Then */
    expect(prevented.some(Boolean)).toBe(false);
    await expectOnScreen(page, order[1]);
});

// ── The question sheet (#377) ──

test('a sideways swipe on the question sheet goes to the next question and back', async ({page, home}) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await askQuestions(home, S.loginFix, [
        {
            question: 'Where should the session cookie be scoped?',
            header: 'Cookie path',
            options: [
                {label: 'The whole site', description: ''},
                {label: 'Only /app', description: ''},
            ],
        },
        {
            question: 'Which checks should run first?',
            header: 'Checks',
            options: [
                {label: 'Unit tests', description: ''},
                {label: 'Lint', description: ''},
            ],
        },
    ]);
    const heading = (name: string) => questionPanel(page).getByRole('heading', {name});
    await expect(heading('Where should the session cookie be scoped?')).toBeVisible();

    /* When */
    await wheel(heading('Where should the session cookie be scoped?'), repeat(16, 20));

    /* Then */
    await expect(heading('Which checks should run first?')).toBeVisible();

    /* When */
    await page.waitForTimeout(300);
    await wheel(heading('Which checks should run first?'), repeat(16, -20));

    /* Then */
    await expect(heading('Where should the session cookie be scoped?')).toBeVisible();
});

// ── Dragging pins into order (#379) ──

/** The middle of the row with this label. */
async function middleOf(page: Page, label: string): Promise<{x: number; y: number}> {
    const box = (await sessionRow(page, label).boundingBox())!;
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

/** The pin of the row with this label. */
const pinOf = (page: Page, label: string): Locator =>
    sessionRow(page, label)
        .locator('xpath=ancestor::*[contains(@class, "session-item")][1]')
        .getByTestId('session-pin');

/** Pin the charts session beside the fixture's pinned release notes: it lands below them. */
async function pinCharts(page: Page): Promise<void> {
    await pinOf(page, LABEL.chartsDarkMode).click();
    await expect(pinOf(page, LABEL.chartsDarkMode)).toHaveClass(/\bpinned\b/);
    await expect(async () => expectRowsInOrder(page, [S.releaseNotes, S.chartsDarkMode])).toPass();
}

test('dragging a pinned session above another reorders Pinned, opens nothing, and the order survives a restart', async ({
    app,
    page,
    home,
}) => {
    /* Given */
    await pinCharts(page);
    const notes = await middleOf(page, LABEL.releaseNotes);

    /* When */
    const charts = await middleOf(page, LABEL.chartsDarkMode);
    await page.mouse.move(charts.x, charts.y);
    await page.mouse.down();
    await page.mouse.move(notes.x, notes.y - 20, {steps: 10});

    /* Then: it is lifted, and the release notes slid down out of its way */
    await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bis-pin-dragging\b/);
    await expect(async () => expect((await middleOf(page, LABEL.releaseNotes)).y).toBeCloseTo(charts.y, 0)).toPass();

    /* When */
    await page.mouse.up();

    /* Then */
    await expect(async () => expectRowsInOrder(page, [S.chartsDarkMode, S.releaseNotes])).toPass();
    await expect(sessionItem(page, S.chartsDarkMode)).not.toHaveClass(/\bis-pin-dragging\b/);
    await expect(sessionItem(page, S.chartsDarkMode)).not.toHaveClass(/\bactive\b/);

    /* When */
    await app.close();
    const again = await launchApp(home);
    try {
        await waitForIndex(again.page, again.app, home);

        /* Then */
        await expect(async () => expectRowsInOrder(again.page, [S.chartsDarkMode, S.releaseNotes])).toPass();
    } finally {
        await again.close();
    }
});

test('Esc puts a dragged pin back where it was', async ({page}) => {
    /* Given */
    await pinCharts(page);
    const charts = await middleOf(page, LABEL.chartsDarkMode);
    const notes = await middleOf(page, LABEL.releaseNotes);
    await page.mouse.move(charts.x, charts.y);
    await page.mouse.down();
    await page.mouse.move(notes.x, notes.y - 20, {steps: 10});
    await expect(async () => expect((await middleOf(page, LABEL.releaseNotes)).y).toBeCloseTo(charts.y, 0)).toPass();

    /* When */
    await page.keyboard.press('Escape');
    await page.mouse.up();

    /* Then: everything springs back */
    await expect(async () => expect((await middleOf(page, LABEL.releaseNotes)).y).toBeCloseTo(notes.y, 0)).toPass();
    await expect(sessionItem(page, S.chartsDarkMode)).not.toHaveClass(/\bis-pin-dragging\b/);
    await expectRowsInOrder(page, [S.releaseNotes, S.chartsDarkMode]);
});

test('a click on a pinned row that wobbles a few px still opens it', async ({page}) => {
    /* Given */
    await pinCharts(page);
    const charts = await middleOf(page, LABEL.chartsDarkMode);

    /* When: pressed, moved past the drag slop but not to another slot, and let go */
    await page.mouse.move(charts.x, charts.y);
    await page.mouse.down();
    await page.mouse.move(charts.x + 2, charts.y + 7, {steps: 3});
    await page.mouse.up();

    /* Then */
    await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bactive\b/);
    await expectRowsInOrder(page, [S.releaseNotes, S.chartsDarkMode]);
});

test('⌥↓ and ⌥↑ move the pinned row at the cursor down and up its section', async ({page}) => {
    /* Given */
    await pinCharts(page);
    await page.keyboard.press('Meta+l');
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);

    /* When */
    await page.keyboard.press('Alt+ArrowDown');

    /* Then: it moved, and the cursor went with it */
    await expect(async () => expectRowsInOrder(page, [S.chartsDarkMode, S.releaseNotes])).toPass();
    await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);

    /* When */
    await page.keyboard.press('Alt+ArrowUp');

    /* Then */
    await expect(async () => expectRowsInOrder(page, [S.releaseNotes, S.chartsDarkMode])).toPass();
});
