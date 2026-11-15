/**
 * The keyboard: walking the session list with a cursor, and the shortcuts that
 * work wherever the focus is — moving between open sessions, the picker,
 * archiving, quick sessions — without one keypress firing twice when it
 * passes through the terminal on its way.
 *
 * The terminal here is the renderer's real xterm, so a key pressed with the
 * focus in it takes the path it takes in the app: what xterm types goes to
 * main as `sendInput`, and what the renderer does with a shortcut goes to main
 * as the call it makes (start, archive). What each key means, and where the
 * cursor or the next session goes, is decided without the app and tested in
 * node (`test/keyboard-shortcuts`, `test/list-cursor`,
 * `test/session-navigation`). Renaming from the cursor, and what the cursor
 * survives, are in `session-list.spec.ts`; Cmd+L on a collapsed sidebar is in
 * `toolbar.spec.ts`.
 */
import {
    test,
    expect,
    globalSettings,
    launchedSince,
    minutesBefore,
    openSession,
    project,
    terminalInput,
    worldOf,
} from '../support/session-list';
import {dialog, searchBox, sessionRow, sidebar, terminalHeader} from '../../e2e/support/app';
import {keyboardCursor, listScroller, renameInput, sessionItem, storedSession} from '../../e2e/support/session-list';
import {sessionId} from '../../e2e/support/fixture-home';
import {LABEL, S} from '../../e2e/fixtures/standard';
import type {FakeApi} from '../support/fake-api';
import type {Page} from '@playwright/test';

const picker = (page: Page) => dialog(page, 'Projects');
const globalSettingsTitle = (page: Page) => page.getByText('Global Settings', {exact: true});

/** Take the focus away from everything, so a key lands on the document itself. */
async function blurAll(page: Page): Promise<void> {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** `count` recent sessions in one project, newest first. */
function manySessions(count: number) {
    return worldOf([
        project('/home/fixture/Development/big', [
            ...Array.from({length: count}, (_, i) => ({
                sessionId: sessionId('many-' + i),
                summary: `Long list session ${String(i + 1).padStart(2, '0')}`,
                modified: minutesBefore(10 + i * 5),
            })),
        ]),
    ]);
}

/** The session ids of these rows, sorted by where they sit on screen. */
async function onScreenOrder(page: Page, ids: readonly string[]): Promise<string[]> {
    const placed = await Promise.all(ids.map(async (id) => ({id, y: (await sessionItem(page, id).boundingBox())!.y})));
    return placed.sort((a, b) => a.y - b.y).map((p) => p.id);
}

/** The sessions the renderer asked main to start, by id. */
function started(api: FakeApi): string[] {
    return api.callsTo('openTerminal').map(([id]) => id);
}

// ── The list's cursor ──

test.describe('the list cursor', () => {
    test('the list takes the keyboard on Cmd+L only, and Esc with no session open lets go of it', async ({page}) => {
        /* Given */
        await blurAll(page);

        /* When */
        for (const key of ['ArrowDown', 'j', 'e', 'a', 'r']) await page.keyboard.press(key);

        /* Then */
        await expect(keyboardCursor(page)).toHaveCount(0);
        await expect(picker(page)).toHaveCount(0);
        await expect(renameInput(page)).toHaveCount(0);

        /* When */
        await page.keyboard.press('Meta+l');

        /* Then */
        await expect(listScroller(page)).toBeFocused();
        await expect(keyboardCursor(page)).toHaveCount(1);
        await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.releaseNotes);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(keyboardCursor(page)).toHaveCount(0);
        await expect(listScroller(page)).not.toBeFocused();
        await expect(sidebar(page).locator(':focus')).toHaveCount(0);
    });

    test('E archives a row or a whole group, Enter unfolds a group and opens a row', async ({page, api}) => {
        /* Given */
        await page.keyboard.press('Meta+l');
        await page.keyboard.press('j');
        await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.loginFix);

        /* When */
        await page.keyboard.press('e');

        /* Then */
        await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);
        await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({archived: 1});
        await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
        await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.worktreeTry);

        /* When */
        // The folded billing group's header is next; its rows are skipped.
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');

        /* Then */
        await expect(keyboardCursor(page)).toContainText(LABEL.billingGroup);
        await expect(sessionRow(page, 'Plan how to move billing out of the monolith')).toBeVisible();

        /* When */
        await page.keyboard.press('ArrowDown');

        /* Then */
        // Unfolded, the group's rows are next in line.
        await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.billingStep2);

        /* When */
        // Back up to the header, and archive the group from there.
        await page.keyboard.press('k');
        await page.keyboard.press('e');

        /* Then */
        await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);
        for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
            await expect.poll(() => storedSession(page, id)).toMatchObject({archived: 1});
        }

        /* When */
        await page.keyboard.press('Enter');

        /* Then */
        await expect.poll(() => started(api)).toEqual([S.chartsDarkMode]);
    });

    test('from the terminal, Cmd+L puts the cursor on the open row; leaving the list clears it, Esc hands the keyboard back', async ({
        page,
        api,
    }) => {
        /* Given */
        await openSession(page, api, LABEL.chartsDarkMode, S.chartsDarkMode);
        await expect(terminalInput(page)).toBeFocused();

        /* When */
        await page.keyboard.press('Meta+l');

        /* Then */
        await expect(listScroller(page)).toBeFocused();
        await expect(keyboardCursor(page)).toHaveCount(1);
        await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);

        /* When */
        await page.keyboard.press('ArrowDown');
        await expect(keyboardCursor(page)).not.toHaveAttribute('data-session-id', S.chartsDarkMode);
        await searchBox(page).click();

        /* Then */
        await expect(keyboardCursor(page)).toHaveCount(0);

        /* When */
        // So the next Cmd+L starts over, on the open row again.
        await page.keyboard.press('Meta+l');

        /* Then */
        await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', S.chartsDarkMode);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(keyboardCursor(page)).toHaveCount(0);
        await expect(terminalInput(page)).toBeFocused();
    });

    test.describe('on a long list', () => {
        test.use({fixture: manySessions(40), settings: globalSettings({visibleSessionCount: 100})});

        test('Cmd+L does not scroll to the open row; stepping scrolls only as far as it has to', async ({
            page,
            api,
        }) => {
            /* Given */
            await sessionRow(page, 'Long list session 20').scrollIntoViewIfNeeded();
            await openSession(page, api, 'Long list session 20', sessionId('many-19'));
            const before = await listScroller(page).evaluate((el) => el.scrollTop);
            expect(before).toBeGreaterThan(0);

            /* When */
            await page.keyboard.press('Meta+l');

            /* Then */
            await expect(keyboardCursor(page)).toHaveAttribute('data-session-id', sessionId('many-19'));
            expect(await listScroller(page).evaluate((el) => el.scrollTop)).toBe(before);

            /* When */
            for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowDown');

            /* Then */
            const cursor = keyboardCursor(page);
            await expect(cursor).toHaveAttribute('data-session-id', sessionId('many-34'));
            // All of it, give or take a fraction of a pixel.
            await expect(cursor).toBeInViewport({ratio: 0.95});
            // "nearest": stepping down pulls the row up to the bottom edge, no further.
            const row = (await cursor.boundingBox())!;
            const list = (await listScroller(page).boundingBox())!;
            expect(Math.abs(row.y + row.height - (list.y + list.height))).toBeLessThanOrEqual(row.height);
            const top = await listScroller(page).evaluate((el) => el.scrollTop);
            expect(top).toBeGreaterThan(before);

            /* When */
            // Stepping back up within the screen does not scroll at all.
            await page.keyboard.press('ArrowUp');

            /* Then */
            expect(await listScroller(page).evaluate((el) => el.scrollTop)).toBe(top);
        });
    });
});

// ── Shortcuts ──

/** Open three sessions; the last one opened is on screen. Returns them in sidebar order. */
async function openThree(page: Page, api: FakeApi): Promise<string[]> {
    await openSession(page, api, LABEL.chartsDarkMode, S.chartsDarkMode);
    await openSession(page, api, LABEL.worktreeTry, S.worktreeTry);
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    return await onScreenOrder(page, [S.loginFix, S.worktreeTry, S.chartsDarkMode]);
}

const LABEL_OF: Record<string, string> = {
    [S.loginFix]: LABEL.loginFix,
    [S.worktreeTry]: LABEL.worktreeTry,
    [S.chartsDarkMode]: LABEL.chartsDarkMode,
};

async function expectOnScreen(page: Page, id: string): Promise<void> {
    await expect(sessionItem(page, id)).toHaveClass(/\bactive\b/);
    await expect(terminalHeader(page)).toContainText(LABEL_OF[id]);
}

test.describe('session navigation', () => {
    test('moves exactly one step from the terminal, and works with the focus outside it too', async ({page, api}) => {
        /* Given */
        const order = await openThree(page, api);
        const at = order.indexOf(S.loginFix);
        await expect(terminalInput(page)).toBeFocused();

        /* When */
        await page.keyboard.press('Meta+ArrowDown');

        /* Then */
        await expectOnScreen(page, order[(at + 1) % order.length]);
        await page.waitForTimeout(300);
        await expectOnScreen(page, order[(at + 1) % order.length]);

        /* When */
        await blurAll(page);
        await page.keyboard.press('Meta+Shift+BracketRight');

        /* Then */
        await expectOnScreen(page, order[(at + 2) % order.length]);
    });
});

test.describe('Cmd+A', () => {
    test('opens the picker, from the terminal or from nowhere', async ({page, api}) => {
        /* When */
        await page.keyboard.press('Meta+a');

        /* Then */
        await expect(picker(page)).toBeVisible();

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(picker(page)).toHaveCount(0);

        /* When */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await expect(terminalInput(page)).toBeFocused();
        await page.keyboard.press('Meta+a');

        /* Then */
        await expect(picker(page)).toHaveCount(1);
    });
});

test.describe('Cmd+E', () => {
    test('archives the open session, from the terminal or with the focus outside it', async ({page, api}) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await expect(terminalInput(page)).toBeFocused();

        /* When */
        await page.keyboard.press('Meta+e');

        /* Then */
        await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({archived: 1});

        /* When */
        await openSession(page, api, LABEL.worktreeTry, S.worktreeTry);
        await blurAll(page);
        await page.keyboard.press('Meta+e');

        /* Then */
        await expect.poll(() => storedSession(page, S.worktreeTry)).toMatchObject({archived: 1});
    });
});

test.describe('quick session, with a folder set', () => {
    test.use({settings: globalSettings({quickSessionPath: '/tmp'})});

    /** The one session started since `before` calls, in the quick session folder. */
    async function expectQuickLaunch(api: FakeApi, before: number): Promise<void> {
        await expect.poll(() => launchedSince(api, before)).toHaveLength(1);
        const [, projectPath, isNew] = api.callsTo('openTerminal')[before]!;
        expect([projectPath, isNew]).toEqual(['/tmp', true]);
    }

    test('a bare N in the terminal is typed; Cmd+N there starts one, once; a bare N outside it starts one', async ({
        page,
        api,
    }) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        const opened = api.callsTo('openTerminal').length;

        /* When */
        await page.keyboard.press('n');

        /* Then */
        await expect.poll(() => api.callsTo('sendInput')).toContainEqual([S.loginFix, 'n']);
        await page.waitForTimeout(800);
        expect(launchedSince(api, opened)).toEqual([]);

        /* When */
        await page.keyboard.press('Meta+n');

        /* Then */
        await expectQuickLaunch(api, opened);
        // One keypress, one session: the document listener stepped aside.
        await page.waitForTimeout(1000);
        expect(launchedSince(api, opened)).toHaveLength(1);

        /* When */
        const quick = api.callsTo('openTerminal').length;
        await blurAll(page);
        await page.keyboard.press('n');

        /* Then */
        await expectQuickLaunch(api, quick);
    });
});

test.describe('quick session, with no folder set', () => {
    test('Cmd+N opens global settings instead', async ({page}) => {
        /* When */
        await page.keyboard.press('Meta+n');

        /* Then */
        await expect(globalSettingsTitle(page)).toBeVisible();
    });
});
