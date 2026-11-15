/**
 * The `test` every component spec imports: a plain Chromium page holding the
 * built renderer, with a `FakeApi` where the preload would be.
 *
 * ```ts
 * import {test, expect} from '../support/test';
 *
 * test.use({answers: {getUpdate: UPDATE}});
 *
 * test('offers the update', async ({page, api}) => {
 *   await api.emit('onStatusUpdate', 'Indexing 4 of 9…', 'progress');
 *   await expect(page.getByText('Version 9.1.0 is available')).toBeVisible();
 * });
 * ```
 *
 * The page is loaded and has made its launch calls by the time the body runs.
 * As in the e2e harness: the clock is frozen at FIXTURE_NOW (or installed, with
 * `fakeTimers`), TZ is UTC, motion is reduced and `confirm` is stubbed.
 */
import {test as base, expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {FakeApi} from './fake-api';
import type {Answers} from './default-answers';
import {captured, type CapturedFixture} from '../fixtures/captured';
import {stubNativeDialogs} from '../../e2e/support/native-dialogs';
import {FIXTURE_NOW, HARNESS_SETTINGS} from '../../e2e/support/fixture-home';

/** The built app (`npm run build`), served by `page.route` with no server. */
const APP_DIR = path.resolve(__dirname, '../../app');
/**
 * localhost, because it is a secure context, as Electron's file:// page is:
 * Chromium leaves `crypto.randomUUID` (which names every new session) out of
 * anything else served over plain http. Nothing listens there; every request
 * is answered from APP_DIR.
 */
const ORIGIN = 'http://localhost';

export interface ComponentOptions {
    /**
     * The sessions `getProjects` answers with: an e2e fixture as the real app
     * answers it (component/fixtures/captured.ts). The standard one by default,
     * as in e2e; null for none.
     */
    fixture: CapturedFixture | null;
    /** Answers in place before the renderer loads, over DEFAULT_ANSWERS. */
    answers: Answers;
    /**
     * The stored settings `getSetting` reads, by key. `global` is merged over
     * the harness's global settings, as an e2e fixture's `settings` is.
     */
    settings: Record<string, unknown>;
    /** Fake timers instead of only a frozen `Date`, for `page.clock.fastForward`. */
    fakeTimers: boolean;
}

export interface ComponentFixtures {
    api: FakeApi;
}

export const test = base.extend<ComponentOptions & ComponentFixtures>({
    fixture: [captured('standard'), {option: true}],
    answers: [{}, {option: true}],
    settings: [{}, {option: true}],
    fakeTimers: [false, {option: true}],

    // The same environment the e2e launch gives the renderer.
    timezoneId: 'UTC',
    locale: 'en-US',
    reducedMotion: 'reduce',

    api: async ({fixture, answers, settings}, use) => {
        const global = {...HARNESS_SETTINGS, ...(settings.global as Record<string, unknown> | undefined)};
        const api = new FakeApi({...settings, global});
        if (fixture) {
            api.handle('getProjects', (showArchived) =>
                showArchived ? fixture.projectsWithArchived : fixture.projects,
            );
        }
        for (const [name, answer] of Object.entries(answers)) {
            api.handle(name as never, (typeof answer === 'function' ? answer : () => answer) as never);
        }
        await use(api);
    },

    page: async ({page, api, fakeTimers}, use, testInfo) => {
        await api.install(page);
        await page.addInitScript(stubNativeDialogs);
        if (fakeTimers) await page.clock.install({time: FIXTURE_NOW});
        else await page.clock.setFixedTime(FIXTURE_NOW);
        await page.route(`${ORIGIN}/**`, (route) => {
            const file = path.join(APP_DIR, decodeURIComponent(new URL(route.request().url()).pathname));
            if (!file.startsWith(APP_DIR) || !fs.existsSync(file)) return route.fulfill({status: 404});
            return route.fulfill({path: file});
        });
        await openRenderer(page);
        await use(page);
        if (api.unhandled.length) {
            await testInfo.attach('unhandled api calls', {body: [...new Set(api.unhandled)].join('\n')});
        }
    },
});

/** Load the renderer and wait for its launch fetch, as the e2e `waitForIndex` does. */
async function openRenderer(page: Page): Promise<void> {
    await page.goto(`${ORIGIN}/renderer/index.html`);
    await expect(page.locator('#sidebar')).toBeVisible();
}

export {expect};
