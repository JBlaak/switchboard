/**
 * Steps for the session list's own spec: finding a row by its session, forcing
 * a redraw, reading the on-screen order, and watching the list's motion.
 *
 * Two of these reach past roles and text, each for a reason:
 *
 * - A row is found by its `data-session-id`. That attribute is a contract in
 *   its own right — the stop's settle motion finds the row by it — and the
 *   state classes a row carries are the thing being checked.
 * - Motion has no accessible handle at all. The recorder watches the inline
 *   transforms and opacities the springs write, and the ghosts a removed row
 *   leaves, which is the only place an animation is observable.
 */
import {expect} from '@playwright/test';
import type {ElectronApplication, Locator, Page} from '@playwright/test';
import {EVENT} from '../../src/ipc/channels';
import {sidebar} from './app';
import {pushEvent} from './main-process';

/** The row (`.session-item`) of one session, by its id. */
export function sessionItem(page: Page, sessionId: string): Locator {
    return sidebar(page).locator(`[data-session-id="${sessionId}"]`);
}

/** The scrolling container the list lives in. A plain div, hence the test id. */
export function listScroller(page: Page): Locator {
    return page.getByTestId('sidebar-content');
}

/** The rename input, which is the list's only text field (the search box sits above it). */
export function renameInput(page: Page): Locator {
    return listScroller(page).getByRole('textbox');
}

/** Assert the rows of these sessions appear top to bottom in this order. */
export async function expectRowsInOrder(page: Page, sessionIds: readonly string[]): Promise<void> {
    const ys: number[] = [];
    for (const id of sessionIds) {
        const box = await sessionItem(page, id).boundingBox();
        expect(box, `the row of ${id} is on screen`).not.toBeNull();
        ys.push(box!.y);
    }
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
}

/** Redraws per page, so a marker is the same on every run of a test. */
const redraws = new WeakMap<Page, number>();

/**
 * Redraw the list from freshly fetched projects, without a re-sort, and wait
 * until the redraw has landed.
 *
 * What a transcript write does, minus the transcript: `projectsChanged` makes
 * the renderer re-fetch and redraw. To know the redraw has happened, a
 * bystander session is renamed first; its new name showing up (visible or not)
 * is the proof. Pick a bystander the test does not look at.
 */
export async function redraw(page: Page, app: ElectronApplication, bystander: string): Promise<void> {
    const count = (redraws.get(page) ?? 0) + 1;
    redraws.set(page, count);
    const marker = `redraw marker ${count}`;
    await page.evaluate(({id, name}) => window.api.renameSession(id, name), {id: bystander, name: marker});
    await pushEvent(app, EVENT.projectsChanged);
    await expect(sidebar(page).getByText(marker, {exact: true})).toHaveCount(1);
}

/** Assert the texts appear top to bottom in this order (each must be visible). */
export async function expectInOrder(page: Page, texts: readonly string[]): Promise<void> {
    const ys: number[] = [];
    for (const text of texts) {
        const box = await sidebar(page).getByText(text, {exact: true}).first().boundingBox();
        expect(box, `"${text}" is on screen`).not.toBeNull();
        ys.push(box!.y);
    }
    const sorted = [...ys].sort((a, b) => a - b);
    expect(ys, `${texts.join(' → ')} top to bottom`).toEqual(sorted);
}

/** Whether `text` sits below the section label `section` and above the next label. */
export async function sectionOf(page: Page, text: string): Promise<string | null> {
    const labels = ['Pinned plans', 'Blocked', 'Your turn', 'Working', 'Merging', 'Pinned', 'Recent'];
    const rowBox = await sidebar(page).getByText(text, {exact: true}).first().boundingBox();
    if (!rowBox) return null;
    let best: {label: string; y: number} | null = null;
    for (const label of labels) {
        const loc = sidebar(page).getByText(label, {exact: true});
        if ((await loc.count()) === 0) continue;
        const box = await loc.first().boundingBox();
        if (!box || box.y > rowBox.y) continue;
        if (!best || box.y > best.y) best = {label, y: box.y};
    }
    return best?.label ?? null;
}

/** Let the springs run: the e2e launch asks for reduced motion, which skips every animation. */
export async function allowMotion(page: Page): Promise<void> {
    await page.emulateMedia({reducedMotion: 'no-preference', colorScheme: null});
    await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
}

/** A row's inline motion, and whether it is on its way out. */
export async function rowNode(
    page: Page,
    sessionId: string,
): Promise<{
    transform: string;
    opacity: string;
    height: string;
    leaving: boolean;
} | null> {
    return await page.evaluate((id) => {
        const row = document.querySelector<HTMLElement>(`[data-session-id="${id}"]`);
        if (!row) return null;
        return {
            transform: row.style.transform,
            opacity: row.style.opacity,
            height: row.style.height,
            leaving: row.hasAttribute('data-leaving'),
        };
    }, sessionId);
}

/** What main has stored for one session (name, star, archive, snooze), read the way the renderer reads it. */
export async function storedSession(
    page: Page,
    sessionId: string,
): Promise<{
    name: string | null;
    starred: number;
    archived: number;
    snoozedUntil: string | null;
} | null> {
    return await page.evaluate(async (id) => {
        const projects = await window.api.getProjects(true);
        for (const project of projects) {
            const found = project.sessions.find((s) => s.sessionId === id);
            if (found) {
                return {
                    name: found.name ?? null,
                    starred: found.starred ?? 0,
                    archived: found.archived ?? 0,
                    snoozedUntil: found.snoozedUntil ?? null,
                };
            }
        }
        return null;
    }, sessionId);
}

/**
 * Whatever the keyboard cursor is on: a row, a group header or a "more"
 * toggle.
 *
 * The cursor has no accessible handle — it is a highlight, not a selection
 * the platform knows about — so this is the one place that names its class.
 */
export function keyboardCursor(page: Page): Locator {
    return listScroller(page).locator('.kbd-cursor');
}
