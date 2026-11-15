/**
 * The sidebar footer: the running count, the activity line main writes into,
 * the quota gauges and the update notice.
 *
 * The timing rules (the activity line's linger, the five-minute usage poll)
 * run on fake timers, so they are checked by jumping the clock rather than by
 * waiting it out. What each part shows for a given state (gauge colours, the
 * notice's labels, what installing asks) is decided in
 * src/renderer/ui/footer/footer-view.ts and tested in test/footer-view.test.ts.
 */
import {test, expect} from '../support/test';
import {sidebarFooter} from '../../e2e/support/app';
import {answerDialogs, dialogsAsked} from '../../e2e/support/native-dialogs';
import type {Locator, Page} from '@playwright/test';
import type {UpdateNotice} from '../../src/domain/update/release';
import type {InstallResult} from '../../src/domain/update/progress';
import type {Usage} from '../../src/domain/usage/usage';

const USAGE_POLL_MS = 5 * 60 * 1000;
/** How often the running sessions are polled while none is running. */
const IDLE_POLL_MS = 30_000;

const UPDATE: UpdateNotice = {
    version: '9.1.0',
    pageUrl: 'https://github.com/JBlaak/switchboard/releases/tag/v9.1.0',
    installable: true,
};

/** Two shared windows at the given percentages. */
function usageAt(session: number, week: number): Usage {
    return {
        limits: [
            {
                kind: 'session',
                label: 'Current session',
                model: null,
                percent: session,
                reset: '6pm (UTC)',
                severity: 'normal',
            },
            {
                kind: 'weekly_all',
                label: 'Week (all models)',
                model: null,
                percent: week,
                reset: 'Jun 12 at 9am (UTC)',
                severity: 'normal',
            },
        ],
    };
}

/** A gauge, by its tooltip: the full label, the percentage and the reset. */
function gauge(page: Page, tooltip: string): Locator {
    return sidebarFooter(page).locator(`[data-tooltip="${tooltip}"]`);
}

function noticeButton(page: Page, name: string): Locator {
    return sidebarFooter(page).getByRole('button', {name, exact: true});
}

/** An install that works never answers: the app quits from under it. */
const pending = (): Promise<InstallResult> => new Promise(() => {});

test.describe('activity line', () => {
    test.use({fakeTimers: true});

    test('shows what main writes; only a done message lingers, for three seconds', async ({page, api}) => {
        /* When */
        await api.emit('onStatusUpdate', 'Indexed 3 sessions', 'done');
        await api.emit('onStatusUpdate', 'Indexing 4 of 9…', 'progress');

        /* Then */
        const progress = sidebarFooter(page).getByText('Indexing 4 of 9…', {exact: true});
        await expect(progress).toBeVisible();
        await expect(sidebarFooter(page).getByText('Indexed 3 sessions')).toHaveCount(0);

        /* When */
        await page.clock.fastForward(10_000);

        /* Then */
        // The done message's linger was cancelled with it.
        await expect(progress).toBeVisible();

        /* When */
        await api.emit('onStatusUpdate', 'Indexed 9 sessions', 'done');
        await page.clock.fastForward(2_500);

        /* Then */
        const done = sidebarFooter(page).getByText('Indexed 9 sessions', {exact: true});
        await expect(done).toBeVisible();

        /* When */
        await page.clock.fastForward(1_000);

        /* Then */
        await expect(done).toHaveCount(0);
    });
});

test.describe('running count', () => {
    test.use({fakeTimers: true});

    test('follows the running sessions main reports, without a reload', async ({page, api}) => {
        /* Given */
        await expect(sidebarFooter(page).getByText(/running$/)).toHaveCount(0);
        api.answer('getActiveSessions', ['a-session']);

        /* When */
        await page.clock.fastForward(IDLE_POLL_MS);

        /* Then */
        await expect(sidebarFooter(page).getByText('1 running', {exact: true})).toBeVisible();
    });
});

test.describe('quota gauges', () => {
    test.use({fakeTimers: true});

    test('show the usage fetched at launch, and fetch it again every five minutes', async ({page, api}) => {
        /* Given */
        const session = gauge(page, 'Current session: 42% — resets 6pm (UTC)');
        await expect(session).toBeVisible();
        api.answer('getUsage', usageAt(85, 90));
        const before = api.callsTo('getUsage').length;

        /* When */
        await page.clock.fastForward(USAGE_POLL_MS - 10_000);

        /* Then */
        expect(api.callsTo('getUsage')).toHaveLength(before);
        await expect(session).toHaveText('5h42%');
        await expect(gauge(page, 'Week (all models): 67% — resets Jun 12 at 9am (UTC)')).toHaveText('Week67%');

        /* When */
        await page.clock.fastForward(10_000);

        /* Then */
        await expect(gauge(page, 'Current session: 85% — resets 6pm (UTC)')).toBeVisible();
        expect(api.callsTo('getUsage')).toHaveLength(before + 1);
    });

    test('keep what they show when a fetch fails, and hide when one has no windows', async ({page, api}) => {
        /* Given */
        const session = gauge(page, 'Current session: 42% — resets 6pm (UTC)');
        await expect(session).toBeVisible();
        api.handle('getUsage', () => {
            throw new Error('usage unavailable');
        });
        const before = api.callsTo('getUsage').length;

        /* When */
        await page.clock.fastForward(USAGE_POLL_MS);

        /* Then */
        await expect.poll(() => api.callsTo('getUsage').length).toBe(before + 1);
        await expect(session).toBeVisible();

        /* When */
        api.answer('getUsage', null);
        await page.clock.fastForward(USAGE_POLL_MS);

        /* Then */
        await expect(session).toBeHidden();
        await expect(sidebarFooter(page).getByText(/%$/)).toHaveCount(0);
    });

    test('show when each window resets while hovered, and nothing otherwise', async ({page}) => {
        for (const tooltip of [
            'Current session: 42% — resets 6pm (UTC)',
            'Week (all models): 67% — resets Jun 12 at 9am (UTC)',
        ]) {
            /* Given */
            const hovered = gauge(page, tooltip);
            await page.mouse.move(0, 0);
            expect(await hoverLabel(hovered)).toBeNull();

            /* When */
            await hovered.hover();

            /* Then */
            expect(await hoverLabel(hovered)).toBe(tooltip);
        }
    });
});

/**
 * The label a gauge paints on hover, or null while none shows. It is a
 * pseudo-element, so it is read from the computed style rather than the DOM.
 */
async function hoverLabel(gauge: Locator): Promise<string | null> {
    return gauge.evaluate((el) => {
        const after = getComputedStyle(el, '::after');
        if (after.content === 'none' || after.display === 'none') return null;
        return JSON.parse(after.content) as string;
    });
}

test.describe('update notice', () => {
    test('links to the release page when main announces one the app cannot install', async ({page, api}) => {
        /* When */
        await api.emit('onUpdateAvailable', {...UPDATE, installable: false});

        /* Then */
        await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', {exact: true})).toBeVisible();

        /* When */
        await noticeButton(page, 'View').click();

        /* Then */
        await expect.poll(() => api.callsTo('openExternal')).toContainEqual([UPDATE.pageUrl]);
        expect(api.callsTo('installUpdate')).toHaveLength(0);
    });

    test.describe('found before launch', () => {
        test.use({answers: {getUpdate: UPDATE, installUpdate: pending}});

        test('is shown from the start, and dismisses that version only, until the window reloads', async ({
            page,
            api,
        }) => {
            /* Given */
            const notice = sidebarFooter(page).getByText(/^Version [\d.]+ is available$/);
            await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', {exact: true})).toBeVisible();

            /* When */
            await noticeButton(page, 'Dismiss').click();

            /* Then */
            await expect(notice).toBeHidden();

            /* When */
            await api.emit('onUpdateAvailable', UPDATE);

            /* Then */
            await expect(notice).toBeHidden();

            /* When */
            await api.emit('onUpdateAvailable', {...UPDATE, version: '9.2.0'});

            /* Then */
            await expect(sidebarFooter(page).getByText('Version 9.2.0 is available', {exact: true})).toBeVisible();

            /* When */
            // Held in memory only: a fresh window offers the dismissed version again.
            await page.reload();

            /* Then */
            await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', {exact: true})).toBeVisible();
        });

        test('counts the running sessions, asks before stopping them, and offers a retry when the install fails', async ({
            page,
            api,
        }) => {
            /* Given */
            api.answer('installUpdate', {ok: false, failure: {step: 'downloading', reason: 'GitHub answered 404.'}});
            api.answer('getActiveSessions', ['a-session']);
            await page.reload();
            await expect(sidebarFooter(page).getByText('1 running', {exact: true})).toBeVisible();

            /* When */
            await answerDialogs(page, false);
            await noticeButton(page, 'Install').click();

            /* Then */
            await expect
                .poll(() => dialogsAsked(page))
                .toEqual(['Restarting to update stops 1 running session. Install now?']);
            await expect(noticeButton(page, 'Install')).toBeEnabled();
            expect(api.callsTo('installUpdate')).toHaveLength(0);

            /* When */
            await answerDialogs(page, true);
            await noticeButton(page, 'Install').click();

            /* Then */
            const failed = sidebarFooter(page).getByText('Download failed', {exact: true});
            await expect(failed).toBeVisible();
            await expect(failed).toHaveAttribute('title', 'GitHub answered 404. This app was left as it was.');
            expect(api.callsTo('installUpdate')).toHaveLength(1);

            /* When */
            api.handle('installUpdate', pending);
            await noticeButton(page, 'Retry').click();

            /* Then */
            await expect(sidebarFooter(page).getByText('Starting the 9.1.0 download…', {exact: true})).toBeVisible();
            await expect(noticeButton(page, 'Retry')).toHaveCount(0);
            expect(api.callsTo('installUpdate')).toHaveLength(2);
        });

        test('follows the install through each step, with a bar for the download', async ({page, api}) => {
            /* Given */
            const bar = sidebarFooter(page).getByRole('progressbar', {name: 'Update progress'});
            const line = (text: string) => sidebarFooter(page).getByText(text, {exact: true});

            /* When */
            await noticeButton(page, 'Install').click();

            /* Then */
            await expect(line('Starting the 9.1.0 download…')).toBeVisible();
            await expect(noticeButton(page, 'Dismiss')).toHaveCount(0);

            /* When */
            await api.emit('onUpdateProgress', {step: 'downloading', received: 41_200_000, total: 98_000_000});

            /* Then */
            await expect(line('Downloading 9.1.0… 42%')).toHaveAttribute('title', '41.2 MB of 98.0 MB');
            await expect(bar).toHaveAttribute('aria-valuenow', '42');

            /* When */
            await api.emit('onUpdateProgress', {step: 'unpacking'});

            /* Then */
            await expect(line('Unpacking 9.1.0…')).toBeVisible();

            /* When */
            await api.emit('onUpdateProgress', {step: 'checking'});

            /* Then */
            await expect(line('Checking 9.1.0…')).toBeVisible();

            /* When */
            await api.emit('onUpdateProgress', {step: 'restarting'});

            /* Then */
            await expect(line('Restarting into 9.1.0…')).toBeVisible();
            await expect(bar).toHaveAttribute('aria-valuenow', '100');
        });
    });

    test.describe('after the restart', () => {
        test.use({answers: {getUpdateOutcome: {kind: 'updated', version: '9.1.0'}}});

        test('says the update arrived, until dismissed', async ({page}) => {
            /* Given */
            const updated = sidebarFooter(page).getByText('Updated to 9.1.0', {exact: true});
            await expect(updated).toBeVisible();

            /* When */
            await noticeButton(page, 'Dismiss').click();

            /* Then */
            await expect(updated).toBeHidden();
        });
    });
});
