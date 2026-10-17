/**
 * The settings viewer, in its global and per-project forms.
 *
 * The weather city lookup's cases are unit tested
 * (test/settings-weather-city.test.ts) and the panel's open/save/close state
 * too (test/settings-slice.test.ts). These tests keep what needs the app: the
 * stored settings read and written through main, the panel swapped in for the
 * terminal or the empty screen, and what saving changes elsewhere.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { dialog, expectScreen, openSession, rowButton, sidebar, terminalHeader } from '../support/app';
import { setHostStub } from '../support/main-process';
import { answerDialogs, dialogsAsked } from '../support/native-dialogs';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import type { Locator, Page } from '@playwright/test';

const UTRECHT = { name: 'Utrecht', latitude: 52.09, longitude: 5.12 };
const BERLIN = { name: 'Berlin', latitude: 52.52, longitude: 13.4 };

async function openGlobalSettings(page: Page) {
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  await expect(globalTitle(page)).toBeVisible();
}

async function openProjectSettings(page: Page, label: string) {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await rowButton(dialog(page, 'New Session').getByText(label, { exact: true }), 'Project settings').click();
  await expect(projectTitle(page, label)).toBeVisible();
}

function globalTitle(page: Page): Locator {
  return page.getByText('Global Settings', { exact: true });
}

function projectTitle(page: Page, label: string): Locator {
  return page.getByText(`Project Settings — ${label}`, { exact: true });
}

/**
 * One row of the form, found through its label.
 *
 * The labels are bare spans, not `<label for>`, so this climbs from the label
 * to the nearest ancestor that holds the row's own control — skipping the
 * "Use global default" checkbox, which sits next to the label in project scope.
 */
function field(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator(
    "xpath=ancestor::*[.//select or .//input[not(ancestor::label[contains(., 'Use global default')])]][1]");
}

/** A row's on/off switch: the last checkbox in the row (after "Use global default"). */
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

function useGlobal(page: Page, label: string): Locator {
  return field(page, label).getByRole('checkbox', { name: 'Use global default', exact: true });
}

function button(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

function emptyScreen(page: Page): Locator {
  return page.getByTestId('empty-screen');
}

async function readSetting(page: Page, key: string): Promise<Record<string, unknown> | null> {
  return await page.evaluate((key) => window.api.getSetting<Record<string, unknown>>(key), key);
}

/**
 * A settings blob without `windowBounds`, which main rewrites by itself
 * whenever the window settles, so it is no evidence either way.
 */
function withoutWindowBounds(settings: Record<string, unknown> | null): Record<string, unknown> {
  const { windowBounds: _ignored, ...rest } = settings ?? {};
  return rest;
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
  test('replaces the terminal, and saving a font and theme refits and recolours it', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect.poll(() => claude.size()?.cols ?? 0).toBeGreaterThan(0);
    const before = claude.size()!;

    /* When */
    await openGlobalSettings(page);

    /* Then */
    await expect(terminalHeader(page)).toBeHidden();

    /* When */
    await field(page, 'Terminal Font Size').getByRole('spinbutton').fill('24');
    await field(page, 'Terminal Theme').getByRole('combobox').selectOption('dracula');
    await button(page, 'Save Settings').click();

    /* Then */
    await expect(globalTitle(page)).toBeHidden();
    await expect(terminalHeader(page)).toBeVisible();
    await expect(emptyScreen(page)).toBeHidden();
    // The bigger font, applied while the terminal had no box, fits on close.
    await expect.poll(() => claude.size()?.cols).toBeLessThan(before.cols);
    const container = page.getByLabel('Terminal input')
      .locator('xpath=ancestor::*[contains(@style, "background-color")][1]');
    await expect(container).toHaveCSS('background-color', 'rgb(40, 42, 54)');
  });
});

test.describe('global fields', () => {
  test.use({
    fixture: {
      ...standardFixture(),
      settings: {
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

  test('show the saved values', async ({ page }) => {
    /* When */
    await openGlobalSettings(page);

    /* Then */
    await expect(field(page, 'Permission Mode').getByRole('combobox')).toHaveValue('acceptEdits');
    await expect(toggle(page, 'Worktree')).toBeChecked();
    await expect(toggle(page, 'Chrome')).toBeChecked();
    await expect(field(page, 'Additional Directories').getByRole('textbox')).toHaveValue('/opt/shared');
    await expect(field(page, 'Pre-launch Command').getByRole('textbox')).toHaveValue('aws-vault exec dev --');
    await expect(field(page, 'Quick Session Folder').getByRole('textbox')).toHaveValue('/tmp/quick');
    await expect(field(page, 'Terminal Theme').getByRole('combobox')).toHaveValue('dracula');
    await expect(field(page, 'Terminal Font').getByRole('textbox')).toHaveValue('Menlo');
    await expect(field(page, 'Terminal Font Size').getByRole('spinbutton')).toHaveValue('15');
    await expect(field(page, 'Terminal Line Height').getByRole('spinbutton')).toHaveValue('1.3');
    await expect(field(page, 'Shell Profile').getByRole('combobox')).toHaveValue('auto');
    // #52: these read the keys that save writes, not the defaults.
    await expect(field(page, 'Max Visible Sessions').getByRole('spinbutton')).toHaveValue('7');
    await expect(field(page, 'Session Max Age (days)').getByRole('spinbutton')).toHaveValue('9');
    await expect(toggle(page, 'Show weather on the empty screen')).toBeChecked();
    await expect(field(page, 'City').getByRole('textbox')).toHaveValue('Utrecht');
    await expect(page.getByText('Weather for Utrecht', { exact: true })).toBeVisible();
    await expect(page.getByText(/^v\d+\.\d+\.\d+/)).toBeVisible();
  });
});

test('scrolled to the bottom, the buttons keep the body padding beneath them', async ({ page }) => {
  /* Given */
  await openGlobalSettings(page);
  const body = page.locator('#settings-viewer-body');

  /* When */
  await body.evaluate(el => el.scrollTo(0, el.scrollHeight));

  /* Then */
  const gap = await body.evaluate(el => {
    const row = el.querySelector('.settings-btn-row')!.getBoundingClientRect();
    return el.getBoundingClientRect().bottom - row.bottom;
  });
  // 32px of padding, give or take subpixel rounding.
  expect(gap).toBeGreaterThan(30);
});

test.describe('global save', () => {
  test('writes every field, merged over the stored settings, and re-syncs the quick session button', async ({ page }) => {
    /* Given */
    const stored = withoutWindowBounds(await readSetting(page, 'global'));
    const quick = page.getByRole('button', { name: 'Quick session (⌘N)', exact: true });

    /* When */
    await openGlobalSettings(page);

    /* Then */
    // Hidden until there is a folder to launch in.
    await expect(quick).toBeHidden();

    /* When */
    await field(page, 'Permission Mode').getByRole('combobox').selectOption('plan');
    await switchOn(page, 'Worktree');
    await switchOn(page, 'Chrome');
    await field(page, 'Additional Directories').getByRole('textbox').fill('/a, /b');
    await field(page, 'Pre-launch Command').getByRole('textbox').fill('direnv exec .');
    await field(page, 'Quick Session Folder').getByRole('textbox').fill('/tmp/scratch');
    await field(page, 'Terminal Theme').getByRole('combobox').selectOption('nord');
    await field(page, 'Terminal Font').getByRole('textbox').fill('Menlo');
    // Out of range: stored clamped to what xterm accepts.
    await field(page, 'Terminal Font Size').getByRole('spinbutton').fill('99');
    await field(page, 'Terminal Line Height').getByRole('spinbutton').fill('0.5');
    await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('4');
    await field(page, 'Session Max Age (days)').getByRole('spinbutton').fill('2');
    await switchOn(page, 'Show weather on the empty screen');
    await button(page, 'Save Settings').click();

    /* Then */
    const saved = button(page, '✓ Saved');
    await expect(saved).toBeVisible();
    // Retried: the button transitions into the colour.
    await expect(saved).toHaveCSS('background-color', await resolvedColor(page, 'var(--sb-mint)'));
    await expect(globalTitle(page)).toBeHidden();
    expect(withoutWindowBounds(await readSetting(page, 'global'))).toEqual({
      ...stored,
      permissionMode: 'plan',
      worktree: true,
      chrome: true,
      addDirs: '/a, /b',
      preLaunchCmd: 'direnv exec .',
      quickSessionPath: '/tmp/scratch',
      terminalTheme: 'nord',
      terminalFontFamily: 'Menlo',
      terminalFontSize: 32,
      terminalLineHeight: 1,
      shellProfile: 'auto',
      visibleSessionCount: 4,
      sessionMaxAgeDays: 2,
      weatherEnabled: true,
      weatherLocation: { name: 'Amsterdam', latitude: 52.3676, longitude: 4.9041 },
    });
    await expect(quick).toBeVisible();
  });

  test('applies the session limits to the sidebar at once', async ({ page }) => {
    /* When */
    await openGlobalSettings(page);

    /* Then */
    await expect(sidebar(page).getByText('+ 3 older', { exact: true })).toBeVisible();

    /* When */
    await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('100');
    await field(page, 'Session Max Age (days)').getByRole('spinbutton').fill('365');
    await button(page, 'Save Settings').click();

    /* Then */
    await expect(globalTitle(page)).toBeHidden();
    await expect(sidebar(page).getByText(/^\+ \d+ older$/)).toHaveCount(0);

    /* When */
    await openGlobalSettings(page);
    await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('1');
    await button(page, 'Save Settings').click();

    /* Then */
    await expect(globalTitle(page)).toBeHidden();
    const older = sidebar(page).getByText(/^\+ \d+ older$/);
    await expect(older).toBeVisible();
    expect(Number((await older.textContent())!.match(/\d+/)![0])).toBeGreaterThan(3);
  });
});

test.describe('global cancel', () => {
  test('closes without saving, back to the empty screen', async ({ page }) => {
    /* Given */
    const before = withoutWindowBounds(await readSetting(page, 'global'));

    /* When */
    await openGlobalSettings(page);

    /* Then */
    await expect(emptyScreen(page)).toBeHidden();
    // The header is a window drag region.
    const region = await globalTitle(page).locator('..').evaluate(el =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region'));
    expect(region).toBe('drag');

    /* When */
    await field(page, 'Pre-launch Command').getByRole('textbox').fill('never-saved');
    await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('2');
    await button(page, 'Cancel').click();

    /* Then */
    await expect(globalTitle(page)).toBeHidden();
    await expect(emptyScreen(page)).toBeVisible();
    expect(withoutWindowBounds(await readSetting(page, 'global'))).toEqual(before);
    await expect(sidebar(page).getByText('+ 3 older', { exact: true })).toBeVisible();

    /* When */
    await openGlobalSettings(page);

    /* Then */
    // The next open starts from what is stored, not from the abandoned edit.
    await expect(field(page, 'Pre-launch Command').getByRole('textbox')).toHaveValue('');
  });
});

test.describe('terminal font warning', () => {
  test('warns live when the font is not installed', async ({ page }) => {
    /* Given */
    await openGlobalSettings(page);
    const input = field(page, 'Terminal Font').getByRole('textbox');
    const warning = page.getByText(/isn't installed; falling back to the default/);

    /* When */
    await input.fill('No Such Font Xyz');

    /* Then */
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('“No Such Font Xyz”');

    /* When */
    await input.fill('Menlo');

    /* Then */
    await expect(warning).toHaveCount(0);

    /* When */
    await input.fill('');

    /* Then */
    await expect(warning).toHaveCount(0);
  });
});

test.describe('weather city', () => {
  test('resolves on change, and Save saves the place it resolves to', async ({ page, app }) => {
    /* Given */
    await setHostStub(app, 'geocode', {
      utrecht: { location: UTRECHT },
      Berlin: { location: BERLIN, delayMs: 600 },
    });
    await openGlobalSettings(page);
    const city = field(page, 'City').getByRole('textbox');

    /* When */
    await city.fill('utrecht');
    await city.press('Tab');

    /* Then */
    await expect(page.getByText('Weather for Utrecht', { exact: true })).toBeVisible();

    /* When */
    await city.fill('Berlin');
    // Clicking Save blurs the field, which starts the lookup just before the click.
    await button(page, 'Save Settings').click();

    /* Then */
    // Save waited for the lookup in flight.
    await expect(globalTitle(page)).toBeHidden();
    expect((await readSetting(page, 'global'))?.weatherLocation).toEqual(BERLIN);
  });
});

test.describe('project scope', () => {
  test.use({
    fixture: {
      ...standardFixture(),
      settings: { preLaunchCmd: 'global-pre', permissionMode: 'plan' },
      projectSettings: { [P.acmeApi]: { addDirs: '/proj' } },
    },
  });

  test('shows the project fields only, global values behind "Use global default"', async ({ page }) => {
    /* When */
    await openProjectSettings(page, P.acmeApi);

    /* Then */
    // Inherited: the global value, checked and disabled.
    await expect(useGlobal(page, 'Pre-launch Command')).toBeChecked();
    await expect(field(page, 'Pre-launch Command').getByRole('textbox')).toHaveValue('global-pre');
    await expect(field(page, 'Pre-launch Command').getByRole('textbox')).toBeDisabled();
    await expect(useGlobal(page, 'Permission Mode')).toBeChecked();
    await expect(field(page, 'Permission Mode').getByRole('combobox')).toHaveValue('plan');
    await expect(field(page, 'Permission Mode').getByRole('combobox')).toBeDisabled();
    await expect(toggle(page, 'Chrome')).toBeDisabled();
    // Overridden: the project's value, unchecked and enabled.
    await expect(useGlobal(page, 'Additional Directories')).not.toBeChecked();
    await expect(field(page, 'Additional Directories').getByRole('textbox')).toHaveValue('/proj');
    await expect(field(page, 'Additional Directories').getByRole('textbox')).toBeEnabled();
    // The application settings are global only.
    for (const label of ['Quick Session Folder', 'Terminal Theme', 'Terminal Font', 'City', 'Version']) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
  });

  test('Save stores only the fields not using the global default', async ({ page, home }) => {
    /* Given */
    await openProjectSettings(page, P.acmeApi);
    // Unchecking "Use global default" enables the field; the fill and switch would fail on a disabled one.
    await useGlobal(page, 'Chrome').uncheck();
    await switchOn(page, 'Chrome');
    await useGlobal(page, 'Permission Mode').uncheck();
    await field(page, 'Permission Mode').getByRole('combobox').selectOption('auto');
    // Back to the global value: dropped from the project's settings.
    await useGlobal(page, 'Additional Directories').check();
    // Edited but still inherited: not saved.
    await useGlobal(page, 'Pre-launch Command').uncheck();
    await field(page, 'Pre-launch Command').getByRole('textbox').fill('direnv exec .');
    await useGlobal(page, 'Pre-launch Command').check();

    /* When */
    await button(page, 'Save Settings').click();

    /* Then */
    await expect(button(page, '✓ Saved')).toBeVisible();
    await expect(projectTitle(page, P.acmeApi)).toBeHidden();
    await expect(emptyScreen(page)).toBeVisible();
    expect(await readSetting(page, 'project:' + home.projectPath(P.acmeApi)))
      .toEqual({ chrome: true, permissionMode: 'auto' });
    // Global settings are untouched.
    expect(await readSetting(page, 'global')).toMatchObject({ preLaunchCmd: 'global-pre', permissionMode: 'plan' });
  });

  test('Cancel closes without saving', async ({ page, home }) => {
    /* Given */
    await openProjectSettings(page, P.acmeApi);
    await useGlobal(page, 'Chrome').uncheck();
    await field(page, 'Additional Directories').getByRole('textbox').fill('/changed');

    /* When */
    await button(page, 'Cancel').click();

    /* Then */
    await expect(projectTitle(page, P.acmeApi)).toBeHidden();
    await expect(emptyScreen(page)).toBeVisible();
    expect(await readSetting(page, 'project:' + home.projectPath(P.acmeApi))).toEqual({ addDirs: '/proj' });
  });

  test('Hide Project asks first, then hides it and shows the empty screen', async ({ page, home }) => {
    /* Given */
    await openProjectSettings(page, P.acmeApi);
    await answerDialogs(page, false);

    /* When */
    await button(page, 'Hide Project').click();

    /* Then */
    expect(await dialogsAsked(page)).toEqual([
      `Hide project "${P.acmeApi}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`,
    ]);
    await expect(projectTitle(page, P.acmeApi)).toBeVisible();

    /* When */
    await answerDialogs(page, true);
    await button(page, 'Hide Project').click();

    /* Then */
    await expect(projectTitle(page, P.acmeApi)).toBeHidden();
    await expect(emptyScreen(page)).toBeVisible();
    await expect.poll(async () => page.evaluate(async (projectPath) => {
      const projects = await window.api.getProjects(false);
      return projects.some(project => project.projectPath === projectPath);
    }, home.projectPath(P.acmeApi))).toBe(false);
    await expect(sidebar(page).getByText(LABEL.loginFix, { exact: true })).toHaveCount(0);
  });
});

forEachAppearance(() => {
  test('global settings', async ({ page }) => {
    /* When */
    await openGlobalSettings(page);

    /* Then */
    await expectScreen(page, 'settings-global');
  });

  test('project settings', async ({ page }) => {
    /* When */
    await openProjectSettings(page, P.acmeApi);

    /* Then */
    await expectScreen(page, 'settings-project');
  });
});
