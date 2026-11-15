/**
 * How the sidebar's chrome above the session list looks: collapsed, with the
 * settings menu open, and with every toolbar control showing.
 *
 * What the controls do — the resize handle, the filters, the search and its
 * debounce, titles only, the gear menu, the sleep switch, collapsing, and the
 * window-drag regions — is in component/tests/toolbar.spec.ts, against what
 * main answers. The rules behind them are tested in node (`test/toolbar-slice`,
 * `test/toolbar-search-filters`, `test/session-list-layout`,
 * `test/appearance`, `test/toolbar-sleep-switch`).
 */
import {expect, forEachAppearance, screenTest, test} from '../support/test';
import {expectScreen, searchBox, sessionRow} from '../support/app';
import {LABEL, standardFixture} from '../fixtures/standard';
import type {Locator, Page} from '@playwright/test';

function button(page: Page, name: string | RegExp): Locator {
    return page.getByRole('button', {name, exact: typeof name === 'string'});
}

const titlesToggle = (page: Page) => button(page, 'Search titles only');
const gearButton = (page: Page) => button(page, 'Global settings');
const sleepButton = (page: Page) => button(page, /sleep|awake/i);
const quickSessionButton = (page: Page) => button(page, 'Quick session (⌘N)');

const SLEEP_DISABLED = 'Sleep is disabled: this Mac stays awake (click to allow sleep)';

forEachAppearance(() => {
    screenTest('sidebar, collapsed', async ({page}) => {
        /* When */
        await button(page, 'Hide sidebar').click();

        /* Then */
        await expect(searchBox(page)).toBeHidden();
        await expect(button(page, 'Show sidebar')).toBeVisible();
        await expectScreen(page, 'sidebar-collapsed');
    });

    screenTest('settings menu, open', async ({page}) => {
        /* When */
        await gearButton(page).click();

        /* Then */
        await expect(page.getByRole('menu', {name: 'Settings'})).toBeVisible();
        await expectScreen(page, 'settings-menu-open');
    });

    test.describe('every toolbar control showing', () => {
        test.use({
            fixture: {...standardFixture(), settings: {quickSessionPath: '/tmp'}},
            stubs: {sleepDisabled: true},
        });

        screenTest('toolbar, all controls', async ({page}) => {
            /* Given */
            await expect(quickSessionButton(page)).toBeVisible();
            await expect(sleepButton(page)).toHaveAttribute('title', SLEEP_DISABLED);

            /* When */
            await titlesToggle(page).click();
            await searchBox(page).fill('billing');

            /* Then */
            await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
            await expectScreen(page, 'toolbar-all-controls');
        });
    });
});
