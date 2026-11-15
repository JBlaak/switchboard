/**
 * The sidebar footer's screenshot, in the real app's pixels.
 *
 * What the footer does (the running count, the activity line, the quota
 * gauges and the update notice) is tested against a fake main process in
 * component/tests/footer.spec.ts, and what each part shows for a given state
 * in test/footer-view.test.ts.
 */
import {test, expect, forEachAppearance, screenTest} from '../support/test';
import {expectScreen, sidebarFooter} from '../support/app';
import {pushEvent} from '../support/main-process';
import {EVENT} from '../../src/ipc/channels';
import type {ElectronApplication} from '@playwright/test';
import type {UpdateNotice} from '../../src/domain/update/release';
import type {Usage} from '../../src/domain/usage/usage';

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

/** A line from main's indexer, as `onStatusUpdate` delivers it. */
async function statusUpdate(app: ElectronApplication, text: string, kind: string): Promise<void> {
    await pushEvent(app, EVENT.statusUpdate, text, kind);
}

forEachAppearance(() => {
    test.describe('busy', () => {
        test.use({stubs: {update: UPDATE, usage: usageAt(63, 86)}});

        screenTest('footer with an update, activity and low quota', async ({page, app}) => {
            /* When */
            await statusUpdate(app, 'Indexing 4 of 9…', 'progress');

            /* Then */
            await expect(sidebarFooter(page).getByText('Indexing 4 of 9…')).toBeVisible();
            await expect(sidebarFooter(page).getByText('Version 9.1.0 is available')).toBeVisible();
            await expectScreen(page, 'footer-busy');
        });
    });
});
