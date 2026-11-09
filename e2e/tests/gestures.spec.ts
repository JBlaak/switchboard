/**
 * Trackpad gestures in the wired app (#374).
 *
 * The recognizer's rules are unit tested on recorded streams
 * (test/gesture-trackpad-swipe.test.ts), and where a swipe on the pane or a
 * question goes in test/session-navigation.test.ts,
 * test/question-panel-keys.test.ts and test/grill-keys.test.ts. This plays a
 * swipe as the wheel events macOS sends for it, one per frame, onto Claude's
 * pane or the question sheet, and checks it does what its twin does.
 */
import {test, expect} from '../support/test';
import {openSession, sessionRow, terminalHeader} from '../support/app';
import {sessionItem} from '../support/session-list';
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
