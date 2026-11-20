/**
 * The global settings viewer, and a project's settings on its page (#176).
 *
 * The weather city lookup's cases are unit tested
 * (test/settings-weather-city.test.ts), the panel's open/save/close state and
 * the project view's too (test/settings-slice.test.ts), and what a project's
 * change stores, when a field overrides the global default and what Reset
 * leaves (test/project-overrides.test.ts). These run the renderer against the
 * settings store main keeps (support/main-world.ts): what the form reads and
 * writes there, the panel or the page swapped in for the terminal or the
 * empty screen, the keys that move between them, and what saving changes
 * elsewhere. A project change reaching a real launch, and the ⌥Space switch
 * letting go of the global shortcut, need the app (e2e/tests/settings.spec.ts).
 */
import {test, expect} from '../support/main-world';
import {chooseProjectAction, sessionRow, sidebar, terminalHeader} from '../../e2e/support/app';
import {answerDialogs, dialogsAsked} from '../../e2e/support/native-dialogs';
import {sessionItem} from '../../e2e/support/session-list';
import {LABEL, P, S} from '../../e2e/fixtures/standard';
import {fixtureProjectPath} from '../fixtures/captured';
import type {FakeApi} from '../support/fake-api';
import type {Locator, Page} from '@playwright/test';

const UTRECHT = {name: 'Utrecht', latitude: 52.09, longitude: 5.12};
const BERLIN = {name: 'Berlin', latitude: 52.52, longitude: 13.4};
/** The `global` blob the e2e harness starts every app with, but the window's bounds. */
const HARNESS_GLOBAL = {appearance: 'light', weatherEnabled: false};
const ACME = fixtureProjectPath(P.acmeApi);

test.use({settings: {global: HARNESS_GLOBAL}, answers: {getAppVersion: '2.18.0'}});

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

/** Open a session by its row, as main would: its terminal opens and fits. */
async function openSession(page: Page, label: string) {
    await sessionRow(page, label).first().click();
    await expect(terminalHeader(page)).toBeVisible();
}

/** Show one page of the global settings, by its name in the list down the left. */
async function showPage(page: Page, name: string): Promise<void> {
    const tab = page.getByRole('tab', {name, exact: true});
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
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

function emptyScreen(page: Page): Locator {
    return page.getByTestId('empty-screen');
}

/** A stored settings blob, as main keeps it. */
function stored(api: FakeApi, key: string): Record<string, unknown> | null {
    return (api.settings[key] as Record<string, unknown> | undefined) ?? null;
}

/** The size main last heard the session's terminal is. */
function terminalSize(api: FakeApi, sessionId: string): {cols: number; rows: number} | null {
    const resizes = api.callsTo('resizeTerminal').filter(([id]) => id === sessionId);
    const last = resizes.at(-1);
    return last ? {cols: last[1], rows: last[2]} : null;
}

/** The colour a CSS colour expression resolves to, as computed styles report it. */
async function resolvedColor(page: Page, expression: string): Promise<string> {
    return await page.evaluate((expression) => {
        const probe = document.createElement('div');
        probe.style.background = expression;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
    }, expression);
}

test.describe('layout', () => {
    test('replaces the terminal, and saving a font and theme refits and recolours it', async ({page, api}) => {
        /* Given */
        await openSession(page, LABEL.loginFix);
        await expect.poll(() => terminalSize(api, S.loginFix)?.cols ?? 0).toBeGreaterThan(0);
        const before = terminalSize(api, S.loginFix)!;

        /* When */
        await openGlobalSettings(page);

        /* Then */
        await expect(terminalHeader(page)).toBeHidden();

        /* When */
        await showPage(page, 'Terminal');
        await field(page, 'Terminal Font Size').getByRole('spinbutton').fill('24');
        await field(page, 'Terminal Theme').getByRole('combobox').selectOption('dracula');
        await button(page, 'Save Settings').click();

        /* Then */
        await expect(globalTitle(page)).toBeHidden();
        await expect(terminalHeader(page)).toBeVisible();
        await expect(emptyScreen(page)).toBeHidden();
        // The bigger font, applied while the terminal had no box, fits on close.
        await expect.poll(() => terminalSize(api, S.loginFix)?.cols).toBeLessThan(before.cols);
        const container = page
            .getByLabel('Terminal input')
            .locator('xpath=ancestor::*[contains(@style, "background-color")][1]');
        await expect(container).toHaveCSS('background-color', 'rgb(40, 42, 54)');
    });
});

test.describe('global fields', () => {
    test.use({
        settings: {
            global: {
                ...HARNESS_GLOBAL,
                permissionMode: 'acceptEdits',
                worktree: true,
                chrome: true,
                addDirs: '/opt/shared',
                preLaunchCmd: 'aws-vault exec dev --',
                quickSessionPath: '/tmp/quick',
                terminalTheme: 'dracula',
                terminalFontFamily: 'Menlo',
                terminalFontSize: 15,
                terminalLineHeight: 1.3,
                visibleSessionCount: 7,
                sessionMaxAgeDays: 9,
                weatherEnabled: true,
                weatherLocation: UTRECHT,
            },
        },
    });

    test('show the saved values', async ({page}) => {
        /* When */
        await openGlobalSettings(page);

        /* Then */
        await expect(field(page, 'Permission Mode').getByRole('combobox')).toHaveValue('acceptEdits');
        await expect(toggle(page, 'Worktree')).toBeChecked();
        await expect(toggle(page, 'Chrome')).toBeChecked();
        await expect(field(page, 'Additional Directories').getByRole('textbox')).toHaveValue('/opt/shared');
        await expect(field(page, 'Pre-launch Command').getByRole('textbox')).toHaveValue('aws-vault exec dev --');
        await expect(field(page, 'Quick Session Folder').getByRole('textbox')).toHaveValue('/tmp/quick');
        await showPage(page, 'Terminal');
        await expect(field(page, 'Terminal Theme').getByRole('combobox')).toHaveValue('dracula');
        await expect(field(page, 'Terminal Font').getByRole('textbox')).toHaveValue('Menlo');
        await expect(field(page, 'Terminal Font Size').getByRole('spinbutton')).toHaveValue('15');
        await expect(field(page, 'Terminal Line Height').getByRole('spinbutton')).toHaveValue('1.3');
        await expect(field(page, 'Shell Profile').getByRole('combobox')).toHaveValue('auto');
        await showPage(page, 'Appearance');
        // #52: these read the keys that save writes, not the defaults.
        await expect(field(page, 'Max Visible Sessions').getByRole('spinbutton')).toHaveValue('7');
        await expect(field(page, 'Session Max Age (days)').getByRole('spinbutton')).toHaveValue('9');
        await expect(toggle(page, 'Show weather on the empty screen')).toBeChecked();
        await expect(field(page, 'City').getByRole('textbox')).toHaveValue('Utrecht');
        await expect(page.getByText('Weather for Utrecht', {exact: true})).toBeVisible();
        await showPage(page, 'About');
        await expect(page.getByText(/^v\d+\.\d+\.\d+/)).toBeVisible();
    });
});

test.describe('global save', () => {
    test('writes every field, merged over the stored settings, and re-syncs the quick session button and the sidebar', async ({
        page,
        api,
    }) => {
        /* Given */
        const before = stored(api, 'global');
        const quick = page.getByRole('button', {name: 'Quick session (⌘N)', exact: true});

        /* When */
        await openGlobalSettings(page);

        /* Then */
        // Hidden until there is a folder to launch in.
        await expect(quick).toBeHidden();
        await expect(sidebar(page).getByText('+ 3 older', {exact: true})).toBeVisible();

        /* When */
        await field(page, 'Permission Mode').getByRole('combobox').selectOption('plan');
        await switchOn(page, 'Worktree');
        await switchOn(page, 'Chrome');
        await field(page, 'Additional Directories').getByRole('textbox').fill('/a, /b');
        await field(page, 'Pre-launch Command').getByRole('textbox').fill('direnv exec .');
        await field(page, 'Quick Session Folder').getByRole('textbox').fill('/tmp/scratch');
        await showPage(page, 'Terminal');
        await field(page, 'Terminal Theme').getByRole('combobox').selectOption('nord');
        await field(page, 'Terminal Font').getByRole('textbox').fill('Menlo');
        // Out of range: stored clamped to what xterm accepts.
        await field(page, 'Terminal Font Size').getByRole('spinbutton').fill('99');
        await field(page, 'Terminal Line Height').getByRole('spinbutton').fill('0.5');
        await showPage(page, 'Appearance');
        await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('4');
        await field(page, 'Session Max Age (days)').getByRole('spinbutton').fill('2');
        await switchOn(page, 'Show weather on the empty screen');
        await field(page, 'Dock Icon').getByRole('combobox').selectOption('patch');
        await showPage(page, 'Integrations');
        await field(page, 'Tasks URL').getByRole('textbox').fill('https://tasks.example.com/mcp');
        await button(page, 'Save Settings').click();

        /* Then */
        const saved = button(page, '✓ Saved');
        await expect(saved).toBeVisible();
        // Retried: the button transitions into the colour.
        await expect(saved).toHaveCSS('background-color', await resolvedColor(page, 'var(--sb-mint)'));
        await expect(globalTitle(page)).toBeHidden();
        expect(stored(api, 'global')).toEqual({
            ...before,
            permissionMode: 'plan',
            worktree: true,
            chrome: true,
            addDirs: '/a, /b',
            preLaunchCmd: 'direnv exec .',
            quickSessionPath: '/tmp/scratch',
            quickAsk: true,
            removeWorktreeOnArchive: false,
            restoreSessions: true,
            blaakTasksUrl: 'https://tasks.example.com/mcp',
            plannerUrl: '',
            terminalTheme: 'nord',
            terminalFontFamily: 'Menlo',
            terminalFontSize: 32,
            terminalLineHeight: 1,
            shellProfile: 'auto',
            visibleSessionCount: 4,
            sessionMaxAgeDays: 2,
            weatherEnabled: true,
            weatherLocation: {name: 'Amsterdam', latitude: 52.3676, longitude: 4.9041},
            appIcon: 'patch',
        });
        await expect(quick).toBeVisible();
        // The session limits apply to the sidebar at once: fewer rows, so more fold away.
        const older = sidebar(page).getByText(/^\+ \d+ older$/);
        await expect(older).not.toHaveText('+ 3 older');
        expect(Number((await older.textContent())!.match(/\d+/)![0])).toBeGreaterThan(3);
    });
});

// What a city resolves to, and how a failed lookup reads, are unit tested (test/settings-weather-city.test.ts).
test.describe('weather city', () => {
    test('Save waits for the lookup in flight and saves the place it resolves to', async ({page, api}) => {
        /* Given */
        api.handle(
            'geocodeWeatherLocation',
            (name) => new Promise((resolve) => setTimeout(() => resolve(name === 'Berlin' ? BERLIN : null), 600)),
        );
        await openGlobalSettings(page);
        await showPage(page, 'Appearance');
        const city = field(page, 'City').getByRole('textbox');

        /* When */
        await city.fill('Berlin');
        // Clicking Save blurs the field, which starts the lookup just before the click.
        await button(page, 'Save Settings').click();

        /* Then */
        // Save waited for the lookup in flight.
        await expect(globalTitle(page)).toBeHidden();
        expect(stored(api, 'global')?.weatherLocation).toEqual(BERLIN);
    });
});

test.describe('project settings on the project page', () => {
    test.use({
        settings: {
            global: {...HARNESS_GLOBAL, preLaunchCmd: 'env SB_GLOBAL=1', permissionMode: 'plan', worktree: true},
            [`project:${ACME}`]: {addDirs: '/proj', chrome: true},
        },
    });

    test('project settings: every field at the value sessions launch with, and which ones override the global default', async ({
        page,
    }) => {
        /* When */
        await openProjectSettings(page, P.acmeApi);

        /* Then */
        const view = projectSettings(page, P.acmeApi);
        await expect(view).toBeFocused();
        await expect(view.getByRole('heading', {level: 1})).toHaveText(`Settings · ${P.acmeApi}`);
        // Inherited: the global value, the same as global.
        await expect(view.getByRole('radio', {name: 'Plan', exact: true})).toHaveAttribute('aria-checked', 'true');
        await expect(projectField(page, 'Permission mode')).toContainText('Same as global.');
        await expect(view.getByLabel('Before Claude starts')).toHaveValue('env SB_GLOBAL=1');
        await expect(projectField(page, 'Before Claude starts')).toContainText('Same as global.');
        await expect(view.getByRole('switch', {name: 'Start new sessions in a worktree'})).toHaveAttribute(
            'aria-checked',
            'true',
        );
        // Overridden: the project's value, and the global one it replaces.
        await expect(view.getByLabel('Extra directories')).toHaveValue('/proj');
        await expect(projectField(page, 'Extra directories')).toContainText('Overrides the global default (none).');
        await expect(view.getByRole('switch', {name: 'Chrome'})).toHaveAttribute('aria-checked', 'true');
        await expect(projectField(page, 'Chrome')).toContainText('Overrides the global default (off).');
        // The application settings are global only, and the old panel stays shut.
        for (const label of ['Quick Session Folder', 'Terminal Theme', 'City', 'Version']) {
            await expect(page.getByText(label, {exact: true})).toHaveCount(0);
        }
        await expect(globalTitle(page)).toBeHidden();
    });

    test('the header’s Settings and ⌘, open it from the page, ⌘[ goes back, and Esc closes the page', async ({
        page,
    }) => {
        /* Given */
        await openSession(page, LABEL.loginFix);
        await sessionItem(page, S.loginFix).getByTestId('project-link').click();
        const overview = page.getByRole('region', {name: 'Project ' + P.acmeApi});
        await expect(overview).toBeFocused();

        /* When */
        await overview.getByRole('button', {name: 'Settings', exact: true}).click();

        /* Then */
        await expect(projectSettings(page, P.acmeApi)).toBeFocused();

        /* When */
        await projectSettings(page, P.acmeApi)
            .getByRole('button', {name: `Back to ${P.acmeApi} (⌘[)`})
            .click();

        /* Then */
        await expect(overview).toBeFocused();

        /* When */
        await page.keyboard.press('Meta+Comma');

        /* Then */
        await expect(projectSettings(page, P.acmeApi)).toBeFocused();
        await expect(globalTitle(page)).toBeHidden();

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(projectSettings(page, P.acmeApi)).toHaveCount(0);
        await expect(terminalHeader(page)).toBeVisible();
        await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
    });

    test('Hide project asks first, then hides it and shows the empty screen', async ({page, api, world}) => {
        /* Given */
        await openProjectSettings(page, P.acmeApi);
        const hide = projectSettings(page, P.acmeApi).getByRole('button', {name: 'Hide project', exact: true});
        await answerDialogs(page, false);

        /* When */
        await hide.click();

        /* Then */
        expect(await dialogsAsked(page)).toEqual([
            `Hide ${P.acmeApi}?\n\nSession files are not deleted. Add the folder again to bring it back.`,
        ]);
        await expect(projectSettings(page, P.acmeApi)).toBeVisible();
        expect(api.callsTo('removeProject')).toEqual([]);

        /* When */
        await answerDialogs(page, true);
        await hide.click();

        /* Then */
        await expect(projectSettings(page, P.acmeApi)).toHaveCount(0);
        await expect(emptyScreen(page)).toBeVisible();
        expect(api.callsTo('removeProject')).toEqual([[ACME]]);
        expect(world.projectPaths()).not.toContain(ACME);
        await expect(sidebar(page).getByText(LABEL.loginFix, {exact: true})).toHaveCount(0);
    });
});

test.describe('saved prompts', () => {
    /** The prompts section of the global form (#344). */
    function prompts(page: Page): Locator {
        return page.locator('#settings-saved-prompts');
    }

    test('adding one stores it at once, and a scope change moves it to the project’s list', async ({page, api}) => {
        /* Given */
        await openGlobalSettings(page);
        await showPage(page, 'Saved prompts');

        /* When */
        await prompts(page).getByRole('button', {name: 'Add a prompt', exact: true}).click();
        await prompts(page).getByRole('textbox', {name: 'Label'}).fill('Where are we?');
        await prompts(page).getByRole('textbox', {name: 'Prompt'}).fill('Summarise {branch} in three lines.');
        await prompts(page).getByRole('radio', {name: 'Put in input'}).click();
        await prompts(page).getByRole('button', {name: 'Save', exact: true}).click();

        /* Then */
        await expect(prompts(page).getByText('⌘1', {exact: true})).toBeVisible();
        await expect
            .poll(() => stored(api, 'global')?.savedPrompts)
            .toMatchObject([{label: 'Where are we?', text: 'Summarise {branch} in three lines.', mode: 'input'}]);

        /* When */
        await prompts(page).getByRole('button', {name: 'Edit “Where are we?”'}).click();
        await prompts(page).getByRole('combobox', {name: 'Scope'}).selectOption(ACME);
        await prompts(page).getByRole('button', {name: 'Save', exact: true}).click();

        /* Then */
        await expect.poll(() => stored(api, `project:${ACME}`)?.savedPrompts).toMatchObject([{label: 'Where are we?'}]);
        expect(stored(api, 'global')?.savedPrompts).toEqual([]);
    });
});

/** A monospace font every machine of the platform has: Menlo ships with macOS, DejaVu with Ubuntu. */
const INSTALLED_MONOSPACE = process.platform === 'darwin' ? 'Menlo' : 'DejaVu Sans Mono';

test.describe('global settings form', () => {
    test('global settings: Save in view while the page scrolls, the font warning, and Cancel saving nothing', async ({
        page,
        api,
    }) => {
        /* Given */
        const before = structuredClone(stored(api, 'global'));

        /* When */
        await openGlobalSettings(page);

        /* Then */
        await expect(emptyScreen(page)).toBeHidden();
        // The header is a window drag region.
        const region = await globalTitle(page)
            .locator('..')
            .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
        expect(region).toBe('drag');

        /* When */
        const pages = page.locator('#settings-pages');
        await pages.evaluate((el) => el.scrollTo(0, el.scrollHeight));

        /* Then */
        // Only the page scrolls: its last row comes into view and Save never leaves it.
        await expect(toggle(page, 'Bring Sessions Back After a Restart').locator('..')).toBeInViewport();
        await expect(button(page, 'Save Settings')).toBeInViewport();
        await expect(button(page, 'Cancel')).toBeInViewport();

        /* When */
        await showPage(page, 'Terminal');
        const font = field(page, 'Terminal Font').getByRole('textbox');
        const warning = page.getByText(/isn't installed; falling back to the default/);
        await font.fill('No Such Font Xyz');

        /* Then */
        // It warns live when the font is not installed.
        await expect(warning).toBeVisible();
        await expect(warning).toContainText('“No Such Font Xyz”');

        /* When */
        await font.fill(INSTALLED_MONOSPACE);

        /* Then */
        await expect(warning).toHaveCount(0);

        /* When */
        await font.fill('');

        /* Then */
        await expect(warning).toHaveCount(0);

        /* When */
        await showPage(page, 'Sessions');
        await field(page, 'Pre-launch Command').getByRole('textbox').fill('never-saved');
        await showPage(page, 'Appearance');
        await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('2');
        await button(page, 'Cancel').click();

        /* Then */
        await expect(globalTitle(page)).toBeHidden();
        await expect(emptyScreen(page)).toBeVisible();
        expect(stored(api, 'global')).toEqual(before);
        expect(api.callsTo('setSetting').filter(([key]) => key === 'global')).toEqual([]);
        await expect(sidebar(page).getByText('+ 3 older', {exact: true})).toBeVisible();

        /* When */
        await openGlobalSettings(page);

        /* Then */
        // The next open starts from what is stored, not from the abandoned edit.
        await expect(field(page, 'Pre-launch Command').getByRole('textbox')).toHaveValue('');
    });
});
