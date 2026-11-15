/**
 * The session list against what main answers: statuses filing rows under
 * their sections, what a redraw leaves alone, where the keyboard goes, the row
 * actions that go through main (pin, stop, archive, rename, snooze), and the
 * motion.
 *
 * Main is the small world in component/support/session-list.ts: what a row
 * action stores, the next `getProjects` reads back, and the running sessions
 * are the ones the renderer opened. What the CLI under a session would say is
 * pushed as main pushes it.
 *
 * The rules behind it — the order, the sections, the anchoring, the
 * truncation, the labels, which buttons a row offers, what a rename stores —
 * are unit tested against the pure layout and the session-list slice
 * (`test/session-list-layout.test.ts`, `test/session-list-slice.test.ts`,
 * `test/session-list-row-labels.test.ts`, `test/session-list-redraw.test.ts`).
 * The drag on the space under a short list moves the real window, and stays in
 * e2e/tests/session-list.spec.ts with the screenshots.
 */
import {
    test,
    expect,
    askQuestions,
    globalSettings,
    launchedSince,
    minutesBefore,
    openRemoteSession,
    openSession,
    project,
    redraw,
    terminalInput,
    worldOf,
} from '../support/session-list';
import {fixtureProjectPath} from '../fixtures/captured';
import {
    dialog,
    rowButton,
    searchBox,
    sessionRow,
    sidebar,
    sidebarFilter,
    terminalHeader,
    terminalStatus,
} from '../../e2e/support/app';
import {answerDialogs, dialogsAsked} from '../../e2e/support/native-dialogs';
import {
    allowMotion,
    listScroller,
    renameInput,
    rowNode,
    sectionOf,
    sessionItem,
    storedSession,
} from '../../e2e/support/session-list';
import {LABEL, P, S} from '../../e2e/fixtures/standard';
import {sessionId} from '../../e2e/support/fixture-home';
import type {Page} from '@playwright/test';

const BILLING_PLAN = 'Plan how to move billing out of the monolith';
const BILLING_STEP_1 = 'Implement the plan: extract the invoice model';

/** `count` recent sessions in one project, newest first, for the long-list cases. */
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

/** Start a plain terminal in a project, the way main lists one: by its PTY. */
async function startPlainTerminal(page: Page, projectPath: string): Promise<string> {
    return await page.evaluate(async (projectPath) => {
        const id = crypto.randomUUID();
        await window.api.openTerminal(id, projectPath, true, {type: 'terminal'});
        return id;
    }, projectPath);
}

// ── Truncation and pinning ──

test.describe('truncation and pin', () => {
    test('old rows fold behind "+ N older", which opens, survives a redraw and closes; pinning and unpinning go through main', async ({
        page,
        api,
    }) => {
        /* When */
        await sidebar(page).getByText('+ 3 older', {exact: true}).click();

        /* Then */
        await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
        await expect(sidebar(page).getByText('- hide older', {exact: true})).toBeVisible();

        /* When */
        await redraw(page, api, S.flakyE2e);

        /* Then */
        await expect(sidebar(page).getByText('- hide older', {exact: true})).toBeVisible();
        await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();

        /* When */
        await sidebar(page).getByText('- hide older', {exact: true}).click();

        /* Then */
        await expect(sidebar(page).getByText('+ 3 older', {exact: true})).toBeVisible();
        await expect(sessionRow(page, LABEL.meetingNotes)).toBeHidden();
        await expect(sessionRow(page, LABEL.bumpDeps)).toBeHidden();
        // Pinned five days ago, and a remote last opened three hours ago: both stay.
        await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
        await expect(sessionRow(page, LABEL.remoteApi)).toBeVisible();

        /* When */
        await sessionRow(page, LABEL.chartsDarkMode).hover();
        await sessionItem(page, S.chartsDarkMode).getByTestId('session-pin').click();

        /* Then */
        // The row moves into Pinned once main has stored it.
        await expect.poll(() => sectionOf(page, LABEL.chartsDarkMode)).toBe('Pinned');
        expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({starred: 1});
        await expect(sessionItem(page, S.chartsDarkMode).getByTestId('session-pin')).toHaveClass(/\bpinned\b/);

        /* When */
        await sessionRow(page, LABEL.releaseNotes).hover();
        await sessionItem(page, S.releaseNotes).getByTestId('session-pin').click();

        /* Then */
        // Unpinned, the old row goes behind "+ N older".
        await expect(sidebar(page).getByText('+ 4 older', {exact: true})).toBeVisible();
        await expect(sessionRow(page, LABEL.releaseNotes)).toBeHidden();
        expect(await storedSession(page, S.releaseNotes)).toMatchObject({starred: 0});
    });
});

// ── What a redraw leaves alone ──

test.describe('a redraw keeps', () => {
    test.describe('on a long list', () => {
        test.use({fixture: manySessions(40), settings: globalSettings({visibleSessionCount: 100})});

        test('the scroll position', async ({page, api}) => {
            /* Given */
            await listScroller(page).evaluate((el) => {
                el.scrollTop = 300;
            });

            /* When */
            await redraw(page, api, sessionId('many-39'));

            /* Then */
            expect(await listScroller(page).evaluate((el) => el.scrollTop)).toBe(300);
        });
    });
});

// ── Focus ──

test.describe('after a redraw', () => {
    test('the terminal takes the keyboard back, but not from the search box, the list or the question panel', async ({
        page,
        api,
    }) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

        /* When */
        await redraw(page, api, S.bumpDeps);

        /* Then */
        await expect(terminalInput(page)).toBeFocused();

        /* When */
        await searchBox(page).focus();
        await redraw(page, api, S.bumpDeps);

        /* Then */
        await expect(searchBox(page)).toBeFocused();

        /* When */
        await page.keyboard.press('Meta+l');
        await redraw(page, api, S.bumpDeps);

        /* Then */
        await expect(terminalInput(page)).not.toBeFocused();
        await expect(sidebar(page).locator(':focus')).toHaveCount(1);

        /* When */
        await askQuestions(api, S.loginFix, [{question: 'Which way?', options: [{label: 'Left'}, {label: 'Right'}]}]);
        const panel = page.getByRole('region', {name: 'Questions from Claude'});
        await panel.getByRole('heading', {name: 'Which way?'}).waitFor();
        await panel.getByRole('button', {name: /Left/}).focus();
        await redraw(page, api, S.bumpDeps);

        /* Then */
        await expect(terminalInput(page)).not.toBeFocused();
        await expect(panel.getByRole('button', {name: /Left/})).toBeFocused();
    });
});

// ── What a row shows ──

test.describe('row state', () => {
    test('follows its session: running, busy, on screen, answered unread and needing attention, filed under its section', async ({
        page,
        api,
    }) => {
        /* Given */
        const row = sessionItem(page, S.loginFix);

        /* When */
        const login = await openSession(page, api, LABEL.loginFix, S.loginFix);

        /* Then */
        await expect(row).toHaveClass(/\bhas-running-pty\b/);
        await expect(row).toHaveClass(/\bactive\b/);
        await expect(row.getByTestId('session-status-dot')).toHaveClass(/\brunning\b/);

        /* When */
        await login.busy(true);

        /* Then */
        await expect(row).toHaveClass(/\bcli-busy\b/);
        await expect.poll(() => sectionOf(page, LABEL.loginFix)).toBe('Working');

        /* When */
        // Look at another session, so the answer arrives unread.
        await sessionRow(page, LABEL.chartsDarkMode).click();
        await login.busy(false);

        /* Then */
        await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bactive\b/);
        await expect(row).not.toHaveClass(/\bactive\b/);
        await expect(row).toHaveClass(/\bresponse-ready\b/);
        await expect(row).not.toHaveClass(/\bcli-busy\b/);
        await expect.poll(() => sectionOf(page, LABEL.loginFix)).toBe('Your turn');

        /* When */
        await login.notify('Claude needs your permission to use Bash');

        /* Then */
        await expect(row).toHaveClass(/\bneeds-attention\b/);
    });

    test("a busy row's spinner stops while the window is out of focus and turns again on focus", async ({
        page,
        api,
    }) => {
        /* Given */
        const login = await openSession(page, api, LABEL.loginFix, S.loginFix);
        await login.busy(true);
        const dot = sessionItem(page, S.loginFix).getByTestId('session-status-dot');
        await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bcli-busy\b/);
        const playState = () => dot.evaluate((el) => getComputedStyle(el).animationPlayState);
        const focusTo = (focused: boolean) =>
            page.evaluate((focused) => {
                Object.defineProperty(document, 'hasFocus', {value: () => focused, configurable: true});
                window.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
            }, focused);
        await focusTo(true);
        await expect.poll(playState).toBe('running');

        /* When */
        await focusTo(false);

        /* Then */
        await expect.poll(playState).toBe('paused');

        /* When */
        await focusTo(true);

        /* Then */
        await expect.poll(playState).toBe('running');
    });

    test('a plain terminal main started gets a row with the terminal badge and only a stop button', async ({
        page,
        api,
    }) => {
        /* When */
        const terminal = await startPlainTerminal(page, fixtureProjectPath(P.notes));
        await redraw(page, api, S.bumpDeps);
        const item = sessionItem(page, terminal);
        await item.hover();

        /* Then */
        await expect(item).toHaveClass(/\bis-terminal\b/);
        await expect(item.getByTestId('terminal-badge')).toHaveCount(1);
        await expect(item.getByRole('button', {includeHidden: true})).toHaveCount(1);
        await expect(item.getByRole('button', {name: 'Stop session', exact: true})).toBeVisible();
    });
});

// ── Slug groups ──

test.describe('slug group', () => {
    test('opens on its header, stays open across a reload, and its sessions open from it', async ({page, api}) => {
        /* When */
        await sessionRow(page, LABEL.billingGroup).first().click();

        /* Then */
        await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();

        /* When */
        await page.reload();

        /* Then */
        await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();

        /* When */
        await openSession(page, api, BILLING_PLAN, S.billingPlan);

        /* Then */
        await expect(sessionItem(page, S.billingPlan)).toHaveClass(/\bactive\b/);
        await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();
    });
});

// ── Row actions ──

test.describe('pin a plan', () => {
    test('a pinned plan files under Pinned plans and stays pinned after a reload', async ({page}) => {
        /* Given */
        const header = sidebar(page).locator('.slug-group-header').filter({hasText: LABEL.billingGroup});

        /* When */
        await header.hover();
        await header.getByTestId('plan-pin').click();

        /* Then */
        await expect.poll(() => sectionOf(page, LABEL.billingGroup)).toBe('Pinned plans');
        await expect(header.getByTestId('plan-pin')).toHaveClass(/\bpinned\b/);
        // The plan's sessions keep their own stars.
        expect(await storedSession(page, S.billingStep1)).toMatchObject({starred: 0});

        /* When */
        await page.reload();

        /* Then */
        await expect.poll(() => sectionOf(page, LABEL.billingGroup)).toBe('Pinned plans');

        /* When */
        await header.hover();
        await header.getByTestId('plan-pin').click();

        /* Then */
        await expect.poll(() => sectionOf(page, LABEL.billingGroup)).toBe('Recent');
        await expect(sidebar(page).getByText('Pinned plans', {exact: true})).toHaveCount(0);
    });
});

test.describe('stop', () => {
    test('asks first, says "disconnect" for a remote, and stops and clears the screen once confirmed', async ({
        page,
        api,
    }) => {
        /* Given */
        await openRemoteSession(page, api, LABEL.remoteApi, S.remoteApi);
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await answerDialogs(page, false);
        const remote = sessionRow(page, LABEL.remoteApi);
        const login = sessionRow(page, LABEL.loginFix);

        /* When */
        await remote.hover();
        await rowButton(remote, 'Disconnect (keeps running on the remote)').click();

        /* Then */
        await expect
            .poll(() => dialogsAsked(page))
            .toEqual(['Disconnect? The session keeps running on the remote machine.']);

        /* When */
        await login.hover();
        await rowButton(login, 'Stop session').click();

        /* Then */
        await expect.poll(async () => (await dialogsAsked(page)).slice(1)).toEqual(['Stop this session?']);
        await expect(terminalStatus(page)).toHaveText('Running');
        expect(api.callsTo('stopSession')).toEqual([]);

        /* When */
        await answerDialogs(page, true);
        await login.hover();
        await rowButton(login, 'Stop session').click();

        /* Then */
        await expect(page.getByTestId('empty-screen')).toBeVisible();
        await expect(terminalHeader(page)).toBeHidden();
        await expect(sessionItem(page, S.loginFix)).not.toHaveClass(/\bhas-running-pty\b/);
        expect(api.callsTo('stopSession')).toEqual([[S.loginFix]]);
    });
});

// FIXTURE_NOW is Wednesday 10 June 2026, 14:00 UTC, and the app runs in UTC.
test.describe('snooze', () => {
    /** The open snooze menu's entries, as their text. */
    function snoozeMenu(page: Page) {
        return page.getByRole('menu', {name: 'Snooze until'}).getByRole('menuitem');
    }

    test('offers the times still ahead, hides the row until its time, and its filter or a search finds it to wake', async ({
        page,
    }) => {
        /* Given */
        const row = sessionRow(page, LABEL.loginFix);
        await row.hover();

        /* When */
        await rowButton(row, 'Snooze').click();

        /* Then */
        await expect(snoozeMenu(page)).toHaveText([
            'Later today15:00',
            'This evening18:00',
            'TomorrowThu 08:00',
            'This weekendFri 18:00',
            'Next weekMon 08:00',
        ]);

        /* When */
        await snoozeMenu(page).getByText('This evening').click();

        /* Then */
        await expect(sessionItem(page, S.loginFix)).toHaveCount(0);
        await expect
            .poll(() => storedSession(page, S.loginFix))
            .toMatchObject({snoozedUntil: '2026-06-10T18:00:00.000Z', archived: 0});

        /* When */
        const filter = sidebarFilter(page, 'snoozed');
        await filter.click();

        /* Then */
        await expect(sidebar(page).locator('.session-item')).toHaveCount(1);
        await expect(row).toBeVisible();

        /* When */
        await filter.click();
        await searchBox(page).fill(LABEL.loginFix);
        await row.hover();
        await rowButton(row, 'Snoozed until 18:00').click();
        await snoozeMenu(page).getByText('Wake').click();

        /* Then */
        await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({snoozedUntil: null});
        await searchBox(page).fill('');
        await expect(row).toBeVisible();
    });

    test.describe('on time', () => {
        test.use({fakeTimers: true});

        // The renderer's wake timer; when a snooze ends is unit tested (test/session-snooze.test.ts).
        test('a snoozed row comes back by itself once its time has come', async ({page}) => {
            /* Given */
            const row = sessionRow(page, LABEL.loginFix);
            await row.hover();
            await rowButton(row, 'Snooze').click();
            await page.getByRole('menu', {name: 'Snooze until'}).getByText('Later today').click();
            await expect(sessionItem(page, S.loginFix)).toHaveCount(0);

            /* When */
            await page.clock.fastForward('01:01:00');

            /* Then */
            await expect(row).toBeVisible();
        });
    });
});

test.describe('archive', () => {
    test('a row is stopped first, then hidden; a group goes whole; a pending row is forgotten', async ({page, api}) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);

        /* When */
        const row = sessionRow(page, LABEL.loginFix);
        await row.hover();
        await rowButton(row, 'Archive').click();

        /* Then */
        await expect(sessionItem(page, S.loginFix)).toHaveCount(0);
        await expect(page.getByTestId('empty-screen')).toBeVisible();
        expect(await storedSession(page, S.loginFix)).toMatchObject({archived: 1});
        expect(await page.evaluate(() => window.api.getActiveSessions())).not.toContain(S.loginFix);
        // Stopped before it was archived.
        const order = api.calls.filter((c) => c.name === 'stopSession' || c.name === 'archiveSession');
        expect(order.map((c) => [c.name, c.args[0]])).toEqual([
            ['stopSession', S.loginFix],
            ['archiveSession', S.loginFix],
        ]);

        /* When */
        const header = sessionRow(page, LABEL.billingGroup).first();
        await header.hover();
        await rowButton(header, 'Archive all sessions in group').click();

        /* Then */
        await expect(sidebar(page).getByText('3 sessions', {exact: true})).toHaveCount(0);
        for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
            expect(await storedSession(page, id)).toMatchObject({archived: 1});
        }

        /* When */
        const before = api.callsTo('openTerminal').length;
        await page.getByRole('button', {name: 'Projects', exact: true}).click();
        await dialog(page, 'Projects').getByText(P.webDashboard, {exact: true}).click();
        await expect.poll(() => launchedSince(api, before)).toHaveLength(1);
        const pending = sessionItem(page, launchedSince(api, before)[0]!);
        await pending.hover();
        await pending.getByRole('button', {name: 'Archive', exact: true}).click();

        /* Then */
        await expect(pending).toHaveCount(0);
    });

    test('a session found by search is unarchived in place and stays in the list', async ({page}) => {
        /* Given */
        await allowMotion(page);
        await searchBox(page).fill('GraphQL');
        const row = sessionRow(page, LABEL.graphqlSpike);
        await row.hover();

        /* When */
        await rowButton(row, 'Unarchive').click();

        /* Then */
        await expect.poll(() => storedSession(page, S.graphqlSpike)).toMatchObject({archived: 0});
        await expect(row).toBeVisible();
        await expect(sessionItem(page, S.graphqlSpike)).not.toHaveClass(/\barchived-item\b/);
        expect(await rowNode(page, S.graphqlSpike)).toMatchObject({leaving: false, height: ''});

        /* When */
        await searchBox(page).fill('');

        /* Then */
        await expect(row).toBeVisible();
        await row.hover();
        await expect(rowButton(row, 'Archive')).toBeVisible();
    });

    test('a row or a group comes back, and says so, when archiving or stopping fails', async ({page, api, main}) => {
        /* Given */
        api.handle('archiveSession', () => {
            throw new Error('the database is locked');
        });
        await answerDialogs(page, true);
        const row = sessionRow(page, LABEL.chartsDarkMode);

        /* When */
        await row.hover();
        await rowButton(row, 'Archive').click();

        /* Then */
        await expect.poll(async () => (await rowNode(page, S.chartsDarkMode))?.leaving).toBe(false);
        await expect(row).toBeVisible();

        /* When */
        main.failStops('the PTY would not die');
        await row.hover();
        await rowButton(row, 'Archive').click();

        /* Then */
        await expect.poll(() => dialogsAsked(page)).toEqual(['Could not stop this session: the PTY would not die']);
        await expect(row).toBeVisible();
        expect(await rowNode(page, S.chartsDarkMode)).toMatchObject({leaving: false});
        expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({archived: 0});

        /* When */
        const header = sessionRow(page, LABEL.billingGroup).first();
        await header.hover();
        await rowButton(header, 'Archive all sessions in group').click();

        /* Then */
        // It stops at the first session it cannot stop.
        await expect.poll(() => dialogsAsked(page)).toHaveLength(2);
        await expect(header).toBeVisible();
        await page.waitForTimeout(200);
        expect(await dialogsAsked(page)).toHaveLength(2);
        for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
            expect(await storedSession(page, id)).toMatchObject({archived: 0});
        }
    });

    test.describe('on a paused clock', () => {
        test.use({fakeTimers: true});

        test('with reduced motion, pauses 450ms before acting, and the row ignores clicks meanwhile', async ({
            page,
            api,
        }) => {
            /* Given */
            await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
            const row = sessionRow(page, LABEL.chartsDarkMode);

            /* When */
            await row.hover();
            await rowButton(row, 'Archive').click();
            await row.click();
            await page.clock.runFor(440);
            // Real time for a launch or a store the click might have set off.
            await page.waitForTimeout(200);

            /* Then */
            expect(api.callsTo('openTerminal')).toHaveLength(0);
            expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({archived: 0});

            /* When */
            await page.clock.runFor(20);

            /* Then */
            await expect.poll(() => storedSession(page, S.chartsDarkMode)).toMatchObject({archived: 1});

            /* When */
            await page.clock.resume();

            /* Then */
            await expect(sessionItem(page, S.chartsDarkMode)).toHaveCount(0);
        });
    });
});

// ── Rename ──

test.describe('rename', () => {
    test('a double-click opens the input; a redraw keeps it; Escape cancels, Enter and leaving it save', async ({
        page,
        api,
    }) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        // Settle the row in its section first: a row that moves (here, from Recent
        // to Ready) is taken out and put back, and the input loses its focus.
        // Open first, too, because the double-click's own clicks open the session:
        // on one not open yet, the terminal it launches takes the focus a moment
        // later, and the input saves and closes as it loses it.
        await redraw(page, api, S.bumpDeps);
        const input = renameInput(page);

        /* When */
        await sessionRow(page, LABEL.loginFix).dblclick();

        /* Then */
        await expect(input).toBeFocused();
        await expect(input).toHaveValue(LABEL.loginFix);
        expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([
            0,
            LABEL.loginFix.length,
        ]);

        /* When */
        await input.fill('Half-typed name');
        await redraw(page, api, S.flakyE2e);

        /* Then */
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('Half-typed name');

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
        await expect(input).toHaveCount(0);

        /* When */
        await sessionRow(page, LABEL.loginFix).dblclick();

        /* Then */
        // It opens again on the old name: Escape stored nothing.
        await expect(input).toHaveValue(LABEL.loginFix);

        /* When */
        await input.fill('Redirect loop, take two');
        await page.keyboard.press('Enter');

        /* Then */
        await expect(sessionRow(page, 'Redirect loop, take two')).toBeVisible();
        await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({name: 'Redirect loop, take two'});

        /* When */
        await sessionRow(page, 'Redirect loop, take two').dblclick();
        await input.fill('Saved on blur');
        await input.blur();

        /* Then */
        await expect(sessionRow(page, 'Saved on blur')).toBeVisible();
        await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({name: 'Saved on blur'});
    });

    test('R and F2 on the keyboard cursor open it, and the list keeps the keyboard and the cursor after', async ({
        page,
        api,
    }) => {
        /* Given */
        await page.keyboard.press('Meta+l');
        await page.keyboard.press('ArrowDown');
        const input = renameInput(page);

        /* When */
        await page.keyboard.press('r');

        /* Then */
        await expect(input).toBeFocused();
        await expect(input).toHaveValue(LABEL.loginFix);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        // Escape hands the keyboard back to the list, cursor on the same row.
        await expect(input).toHaveCount(0);
        await expect(listScroller(page)).toBeFocused();

        /* When */
        await page.keyboard.press('F2');
        await input.fill('Renamed from the keyboard');
        await page.keyboard.press('Enter');

        /* Then */
        await expect(sessionRow(page, 'Renamed from the keyboard')).toBeVisible();
        await expect(listScroller(page)).toBeFocused();

        /* When */
        // The cursor survives a redraw too: Enter opens the row it sat on.
        await redraw(page, api, S.bumpDeps);
        await page.keyboard.press('Enter');

        /* Then */
        await expect.poll(() => api.callsTo('openTerminal').map(([id]) => id)).toEqual([S.loginFix]);
    });
});
