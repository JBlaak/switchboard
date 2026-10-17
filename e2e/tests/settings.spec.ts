/**
 * The settings viewer, in its global and per-project forms.
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
  return page.getByText('Global Settings — Global', { exact: true });
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

test.describe('smoke', () => {
  test('global settings save and close', async ({ page }) => {
    await openGlobalSettings(page);
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect(page.getByText('Global Settings — Global', { exact: true })).toBeHidden();
    const global = await page.evaluate(() => window.api.getSetting<Record<string, unknown>>('global'));
    // The form writes back what it was opened with, and keeps the harness's own keys.
    expect(global).toMatchObject({ sessionMaxAgeDays: 3, weatherEnabled: false, appearance: 'light' });
  });

  test('project settings open from the picker and cancel', async ({ page }) => {
    await openProjectSettings(page, P.acmeApi);
    await expect(page.getByRole('button', { name: 'Hide Project', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText(`Project Settings — ${P.acmeApi}`, { exact: true })).toBeHidden();
  });
});

test.describe('layout', () => {
  test('replaces the empty screen, and Cancel brings it back', async ({ page }) => {
    await expect(emptyScreen(page)).toBeVisible();
    await openGlobalSettings(page);
    await expect(emptyScreen(page)).toBeHidden();
    await button(page, 'Cancel').click();
    await expect(globalTitle(page)).toBeHidden();
    await expect(emptyScreen(page)).toBeVisible();
  });

  test('replaces the terminal, and closing restores and refits it', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect.poll(() => claude.size()?.cols ?? 0).toBeGreaterThan(0);
    const before = claude.size()!;

    await openGlobalSettings(page);
    await expect(terminalHeader(page)).toBeHidden();
    await field(page, 'Terminal Font Size').getByRole('spinbutton').fill('24');
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();

    await expect(terminalHeader(page)).toBeVisible();
    await expect(emptyScreen(page)).toBeHidden();
    // The bigger font, applied while the terminal had no box, fits on close.
    await expect.poll(() => claude.size()?.cols).toBeLessThan(before.cols);
  });

  test('the header is a window drag region', async ({ page }) => {
    await openGlobalSettings(page);
    const region = await globalTitle(page).locator('..').evaluate(el =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region'));
    expect(region).toBe('drag');
  });
});

test.describe('global fields', () => {
  test.use({
    fixture: {
      ...standardFixture(),
      settings: {
        permissionMode: 'acceptEdits',
        worktree: true,
        worktreeName: 'feature',
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
    await openGlobalSettings(page);
    await expect(field(page, 'Permission Mode').getByRole('combobox')).toHaveValue('acceptEdits');
    await expect(toggle(page, 'Worktree')).toBeChecked();
    await expect(field(page, 'Worktree Name').getByRole('textbox')).toHaveValue('feature');
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

test.describe('global save', () => {
  test('writes every field, merged over the stored settings', async ({ page }) => {
    const stored = withoutWindowBounds(await readSetting(page, 'global'));
    await openGlobalSettings(page);
    await field(page, 'Permission Mode').getByRole('combobox').selectOption('plan');
    await switchOn(page, 'Worktree');
    await field(page, 'Worktree Name').getByRole('textbox').fill('  wt  ');
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
    const saved = button(page, '✓ Saved');
    await expect(saved).toBeVisible();
    // Retried: the button transitions into the colour.
    await expect(saved).toHaveCSS('background-color', await resolvedColor(page, 'var(--sb-mint)'));
    await expect(globalTitle(page)).toBeHidden();

    expect(withoutWindowBounds(await readSetting(page, 'global'))).toEqual({
      ...stored,
      permissionMode: 'plan',
      worktree: true,
      worktreeName: 'wt',
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
  });

  test('applies the session limits to the sidebar at once', async ({ page }) => {
    await expect(sidebar(page).getByText('+ 3 older', { exact: true })).toBeVisible();

    await openGlobalSettings(page);
    await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('100');
    await field(page, 'Session Max Age (days)').getByRole('spinbutton').fill('365');
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    await expect(sidebar(page).getByText(/^\+ \d+ older$/)).toHaveCount(0);

    await openGlobalSettings(page);
    await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('1');
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    const older = sidebar(page).getByText(/^\+ \d+ older$/);
    await expect(older).toBeVisible();
    expect(Number((await older.textContent())!.match(/\d+/)![0])).toBeGreaterThan(3);
  });

  test('applies the terminal theme to open terminals at once', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await openGlobalSettings(page);
    await field(page, 'Terminal Theme').getByRole('combobox').selectOption('dracula');
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    const container = page.getByLabel('Terminal input')
      .locator('xpath=ancestor::*[contains(@style, "background-color")][1]');
    await expect(container).toHaveCSS('background-color', 'rgb(40, 42, 54)');
  });

  test('re-syncs the quick session button', async ({ page }) => {
    // Hidden until there is a folder to launch in.
    const quick = page.getByRole('button', { name: 'Quick session (⌘N)', exact: true });
    await expect(quick).toBeHidden();
    await openGlobalSettings(page);
    await field(page, 'Quick Session Folder').getByRole('textbox').fill('/tmp/quick-folder');
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    await expect(quick).toBeVisible();
  });
});

test.describe('global cancel', () => {
  test('closes without saving', async ({ page }) => {
    const before = withoutWindowBounds(await readSetting(page, 'global'));
    await openGlobalSettings(page);
    await field(page, 'Worktree Name').getByRole('textbox').fill('never-saved');
    await field(page, 'Max Visible Sessions').getByRole('spinbutton').fill('2');
    await button(page, 'Cancel').click();
    await expect(globalTitle(page)).toBeHidden();
    expect(withoutWindowBounds(await readSetting(page, 'global'))).toEqual(before);
    await expect(sidebar(page).getByText('+ 3 older', { exact: true })).toBeVisible();

    // And the next open starts from what is stored, not from the abandoned edit.
    await openGlobalSettings(page);
    await expect(field(page, 'Worktree Name').getByRole('textbox')).toHaveValue('');
  });
});

test.describe('terminal font warning', () => {
  test('warns live when the font is not installed', async ({ page }) => {
    await openGlobalSettings(page);
    const input = field(page, 'Terminal Font').getByRole('textbox');
    const warning = page.getByText(/isn't installed; falling back to the default/);
    await expect(warning).toHaveCount(0);

    await input.fill('No Such Font Xyz');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('“No Such Font Xyz”');

    await input.fill('Menlo');
    await expect(warning).toHaveCount(0);
    await input.fill('');
    await expect(warning).toHaveCount(0);
  });
});

test.describe('weather city', () => {
  test('resolves on change and saves the resolved place', async ({ page, app }) => {
    await setHostStub(app, 'geocode', { utrecht: { location: UTRECHT } });
    await openGlobalSettings(page);
    await expect(page.getByText('Weather for Amsterdam', { exact: true })).toBeVisible();
    const city = field(page, 'City').getByRole('textbox');
    await city.fill('utrecht');
    await city.press('Tab');
    await expect(page.getByText('Weather for Utrecht', { exact: true })).toBeVisible();
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    expect((await readSetting(page, 'global'))?.weatherLocation).toEqual(UTRECHT);
  });

  test('keeps the previous place when nothing is found', async ({ page }) => {
    await openGlobalSettings(page);
    const city = field(page, 'City').getByRole('textbox');
    await city.fill('Atlantis');
    await city.press('Tab');
    await expect(page.getByText('— couldn\'t find “Atlantis”; keeping Amsterdam.', { exact: false })).toBeVisible();
    await expect(page.getByText('Weather for Amsterdam', { exact: false })).toBeVisible();
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    expect((await readSetting(page, 'global'))?.weatherLocation).toMatchObject({ name: 'Amsterdam' });
  });

  test('keeps the previous place when the lookup fails', async ({ page, app }) => {
    await setHostStub(app, 'geocode', { Utrecht: 'fail' });
    await openGlobalSettings(page);
    const city = field(page, 'City').getByRole('textbox');
    await city.fill('Utrecht');
    await city.press('Tab');
    await expect(page.getByText('— couldn\'t look up “Utrecht”; keeping Amsterdam.', { exact: false })).toBeVisible();
  });

  test('ignores a result for text that has since changed', async ({ page, app }) => {
    await setHostStub(app, 'geocode', { Berlin: { location: BERLIN, delayMs: 600 } });
    await openGlobalSettings(page);
    const city = field(page, 'City').getByRole('textbox');
    await city.fill('Berlin');
    await city.press('Tab');
    // Typed over while Berlin resolves, without committing the new text.
    await city.fill('Ber');
    await page.waitForTimeout(1000);
    await expect(page.getByText('Weather for Amsterdam', { exact: true })).toBeVisible();
  });

  test('Save waits for a lookup in flight', async ({ page, app }) => {
    await setHostStub(app, 'geocode', { Berlin: { location: BERLIN, delayMs: 600 } });
    await openGlobalSettings(page);
    const city = field(page, 'City').getByRole('textbox');
    await city.fill('Berlin');
    // Clicking Save blurs the field, which starts the lookup just before the click.
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    expect((await readSetting(page, 'global'))?.weatherLocation).toEqual(BERLIN);
  });

  test('an empty city goes back to the default', async ({ page }) => {
    await openGlobalSettings(page);
    const city = field(page, 'City').getByRole('textbox');
    await city.fill('');
    await city.press('Tab');
    await expect(page.getByText('Weather for Amsterdam', { exact: true })).toBeVisible();
  });
});

test.describe('project scope', () => {
  test.use({
    fixture: {
      ...standardFixture(),
      settings: { preLaunchCmd: 'global-pre', permissionMode: 'plan' },
      projectSettings: { [P.acmeApi]: { worktreeName: 'proj-wt' } },
    },
  });

  test('shows the project fields only, global values behind "Use global default"', async ({ page }) => {
    await openProjectSettings(page, P.acmeApi);
    // Inherited: the global value, checked and disabled.
    await expect(useGlobal(page, 'Pre-launch Command')).toBeChecked();
    await expect(field(page, 'Pre-launch Command').getByRole('textbox')).toHaveValue('global-pre');
    await expect(field(page, 'Pre-launch Command').getByRole('textbox')).toBeDisabled();
    await expect(useGlobal(page, 'Permission Mode')).toBeChecked();
    await expect(field(page, 'Permission Mode').getByRole('combobox')).toHaveValue('plan');
    await expect(field(page, 'Permission Mode').getByRole('combobox')).toBeDisabled();
    await expect(toggle(page, 'Chrome')).toBeDisabled();
    // Overridden: the project's value, unchecked and enabled.
    await expect(useGlobal(page, 'Worktree Name')).not.toBeChecked();
    await expect(field(page, 'Worktree Name').getByRole('textbox')).toHaveValue('proj-wt');
    await expect(field(page, 'Worktree Name').getByRole('textbox')).toBeEnabled();
    // The application settings are global only.
    for (const label of ['Quick Session Folder', 'Terminal Theme', 'Terminal Font', 'City', 'Version']) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
  });

  test('"Use global default" disables and enables its field', async ({ page }) => {
    await openProjectSettings(page, P.acmeApi);
    const input = field(page, 'Additional Directories').getByRole('textbox');
    await expect(input).toBeDisabled();
    await useGlobal(page, 'Additional Directories').uncheck();
    await expect(input).toBeEnabled();
    await useGlobal(page, 'Additional Directories').check();
    await expect(input).toBeDisabled();
    await useGlobal(page, 'Worktree').uncheck();
    await expect(toggle(page, 'Worktree')).toBeEnabled();
  });

  test('Save stores only the fields not using the global default', async ({ page, home }) => {
    await openProjectSettings(page, P.acmeApi);
    await useGlobal(page, 'Chrome').uncheck();
    await switchOn(page, 'Chrome');
    await useGlobal(page, 'Permission Mode').uncheck();
    await field(page, 'Permission Mode').getByRole('combobox').selectOption('auto');
    // Back to the global value: dropped from the project's settings.
    await useGlobal(page, 'Worktree Name').check();
    // Edited but still inherited: not saved.
    await useGlobal(page, 'Additional Directories').uncheck();
    await field(page, 'Additional Directories').getByRole('textbox').fill('/x');
    await useGlobal(page, 'Additional Directories').check();

    await button(page, 'Save Settings').click();
    await expect(button(page, '✓ Saved')).toBeVisible();
    await expect(projectTitle(page, P.acmeApi)).toBeHidden();
    await expect(emptyScreen(page)).toBeVisible();
    expect(await readSetting(page, 'project:' + home.projectPath(P.acmeApi)))
      .toEqual({ chrome: true, permissionMode: 'auto' });
    // Global settings are untouched.
    expect(await readSetting(page, 'global')).toMatchObject({ preLaunchCmd: 'global-pre', permissionMode: 'plan' });
  });

  test('Cancel closes without saving', async ({ page, home }) => {
    await openProjectSettings(page, P.acmeApi);
    await useGlobal(page, 'Chrome').uncheck();
    await field(page, 'Worktree Name').getByRole('textbox').fill('changed');
    await button(page, 'Cancel').click();
    await expect(projectTitle(page, P.acmeApi)).toBeHidden();
    await expect(emptyScreen(page)).toBeVisible();
    expect(await readSetting(page, 'project:' + home.projectPath(P.acmeApi))).toEqual({ worktreeName: 'proj-wt' });
  });

  test('Hide Project asks first, then hides it and shows the empty screen', async ({ page, home }) => {
    await openProjectSettings(page, P.acmeApi);
    await answerDialogs(page, false);
    await button(page, 'Hide Project').click();
    expect(await dialogsAsked(page)).toEqual([
      `Hide project "${P.acmeApi}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`,
    ]);
    await expect(projectTitle(page, P.acmeApi)).toBeVisible();

    await answerDialogs(page, true);
    await button(page, 'Hide Project').click();
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
    await openGlobalSettings(page);
    await expectScreen(page, 'settings-global');
  });

  test('project settings', async ({ page }) => {
    await openProjectSettings(page, P.acmeApi);
    await expectScreen(page, 'settings-project');
  });
});
