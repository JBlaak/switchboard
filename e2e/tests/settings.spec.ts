/**
 * The global settings viewer, and a project's settings on its page (#176), in
 * the app: what a project's change does to the next real launch,
 * and the ⌥Space switch letting go of the global shortcut.
 *
 * The weather city lookup's cases are unit tested
 * (test/settings-weather-city.test.ts), the panel's open/save/close state and
 * the project view's too (test/settings-slice.test.ts), and what a project's
 * change stores, when a field overrides the global default and what Reset
 * leaves (test/project-overrides.test.ts). What the form shows and saves, the
 * terminal it refits, the keys between the panel, the page and the terminal,
 * Hide project, saved prompts and the weather lookup are component tested
 * (component/tests/settings.spec.ts).
 */
import {test, expect} from '../support/test';
import {chooseProjectAction} from '../support/app';
import {launchedKeys, waitForNewLaunch} from '../support/fake-cli';
import {pressQuickAsk, refuseQuickAskHotkey} from '../support/main-process';
import {P, standardFixture} from '../fixtures/standard';
import type {Locator, Page} from '@playwright/test';

async function openGlobalSettings(page: Page) {
    await page.getByRole('button', {name: 'Global settings', exact: true}).click();
    await page.getByRole('menuitem', {name: 'All settings…'}).click();
    await expect(globalTitle(page)).toBeVisible();
}

/** A project's settings, from the Projects modal's ⋯ menu. */
async function openProjectSettings(page: Page, label: string) {
    await page.getByRole('button', {name: 'Projects', exact: true}).click();
    await chooseProjectAction(page, label, 'Project settings');
    await expect(projectSettings(page, label)).toBeVisible();
}

function globalTitle(page: Page): Locator {
    return page.getByText('Global Settings', {exact: true});
}

/** A project's settings view, on its page. */
function projectSettings(page: Page, label: string): Locator {
    return page.getByRole('region', {name: `Settings for ${label}`});
}

/** One field of a project's settings view, found through its label. */
function projectField(page: Page, label: string): Locator {
    return projectSettings(page, P.acmeApi)
        .getByText(label, {exact: true})
        .locator("xpath=ancestor::*[contains(concat(' ', @class, ' '), ' ps-field ')][1]");
}

/**
 * One row of the global form, found through its label.
 *
 * The labels are bare spans, not `<label for>`, so this climbs from the label
 * to the nearest ancestor that holds the row's own control.
 */
function field(page: Page, label: string): Locator {
    return page.getByText(label, {exact: true}).locator('xpath=ancestor::*[.//select or .//input][1]');
}

/** A row's on/off switch. */
function toggle(page: Page, label: string): Locator {
    return field(page, label).getByRole('checkbox').last();
}

/**
 * Turn a switch on the way a user does, by clicking it. Its input is hidden
 * (zero size), so the click goes to the label that wraps it.
 */
async function switchOn(page: Page, label: string): Promise<void> {
    await toggle(page, label).locator('..').click();
    await expect(toggle(page, label)).toBeChecked();
}

function button(page: Page, name: string): Locator {
    return page.getByRole('button', {name, exact: true});
}

async function readSetting(page: Page, key: string): Promise<Record<string, unknown> | null> {
    return await page.evaluate((key) => window.api.getSetting<Record<string, unknown>>(key), key);
}

test.describe('quick ask', () => {
    // Taking it back, and trying again after a refusal, are unit tested (test/quick-ask-hotkey.test.ts).
    test('the switch lets go of ⌥Space, and says when another app holds it', async ({page, app}) => {
        /* Given */
        const label = 'Open Quick Ask with ⌥Space';
        const inUse = page.getByText('⌥Space is in use by another app', {exact: true});
        await openGlobalSettings(page);

        /* Then */
        // Unset counts as on, and main took the key at startup.
        await expect(toggle(page, label)).toBeChecked();
        await expect(inUse).toHaveCount(0);
        expect(await pressQuickAsk(app)).toBe(true);

        /* When */
        await toggle(page, label).locator('..').click();
        await button(page, 'Save Settings').click();

        /* Then */
        await expect(globalTitle(page)).toBeHidden();
        expect((await readSetting(page, 'global'))?.quickAsk).toBe(false);
        expect(await pressQuickAsk(app)).toBe(false);

        /* When */
        await refuseQuickAskHotkey(app, true);
        await openGlobalSettings(page);
        await switchOn(page, label);
        await button(page, 'Save Settings').click();
        await expect(globalTitle(page)).toBeHidden();
        await openGlobalSettings(page);

        /* Then */
        await expect(toggle(page, label)).toBeChecked();
        await expect(inUse).toBeVisible();
        expect(await pressQuickAsk(app)).toBe(false);
    });
});

test.describe('project settings on the project page', () => {
    const OVERRIDES = {
        ...standardFixture(),
        settings: {preLaunchCmd: 'env SB_GLOBAL=1', permissionMode: 'plan', worktree: true},
        projectSettings: {[P.acmeApi]: {addDirs: '/proj', chrome: true}},
    };
    test.use({fixture: OVERRIDES});

    test('a change saves at once, the next session started in the project launches with it, and Reset drops every override', async ({
        page,
        home,
    }) => {
        /* Given */
        await openProjectSettings(page, P.acmeApi);
        const view = projectSettings(page, P.acmeApi);
        const saved = view.getByText('Saved · applies to new sessions', {exact: true});
        await expect(saved).toHaveCount(0);

        /* When */
        await view.getByRole('radio', {name: 'Accept edits', exact: true}).click();

        /* Then */
        await expect(saved).toBeVisible();
        await expect(projectField(page, 'Permission mode')).toContainText('Overrides the global default (Plan).');
        await expect
            .poll(() => readSetting(page, 'project:' + home.projectPath(P.acmeApi)))
            .toEqual({addDirs: '/proj', chrome: true, permissionMode: 'acceptEdits'});

        /* When */
        // Back to the global value: no longer the project's own.
        await view.getByRole('switch', {name: 'Chrome'}).click();
        await view.getByLabel('Extra directories').fill('/a, /b');
        await view.getByLabel('Extra directories').press('Enter');

        /* Then */
        await expect(projectField(page, 'Chrome')).toContainText('Same as global.');
        await expect
            .poll(() => readSetting(page, 'project:' + home.projectPath(P.acmeApi)))
            .toEqual({addDirs: '/a, /b', permissionMode: 'acceptEdits'});
        // Global settings are untouched.
        expect(await readSetting(page, 'global')).toMatchObject({
            preLaunchCmd: 'env SB_GLOBAL=1',
            permissionMode: 'plan',
            worktree: true,
        });

        /* When */
        await view.getByLabel('Before Claude starts').fill('env SB_PROJECT=1');
        // ⌘[ with the edit still in the box: it is stored as the view closes.
        await page.keyboard.press('Meta+BracketLeft');

        /* Then */
        const overview = page.getByRole('region', {name: 'Project ' + P.acmeApi});
        await expect(overview).toBeFocused();
        await expect
            .poll(async () => (await readSetting(page, 'project:' + home.projectPath(P.acmeApi)))?.preLaunchCmd)
            .toBe('env SB_PROJECT=1');

        /* When */
        const before = launchedKeys(home);
        await overview.getByRole('button', {name: 'New session', exact: true}).click();

        /* Then */
        const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
        const argv = launch.argv.join(' ');
        expect(argv).toContain('--permission-mode acceptEdits');
        expect(argv).toContain('--add-dir /a --add-dir /b');
        expect(argv).not.toContain('--chrome');

        /* When */
        // What Reset leaves is unit tested (test/project-overrides.test.ts); here, that it reaches main.
        await openProjectSettings(page, P.acmeApi);
        const reset = view.getByRole('button', {name: 'Reset to global settings', exact: true});
        await reset.click();

        /* Then */
        await expect(reset).toBeDisabled();
        await expect.poll(() => readSetting(page, 'project:' + home.projectPath(P.acmeApi))).toEqual({});
    });
});
