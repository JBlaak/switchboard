/**
 * The global settings viewer, and a project's settings on its page (#176).
 *
 * The weather city lookup's cases are unit tested
 * (test/settings-weather-city.test.ts), the panel's open/save/close state and
 * the project view's too (test/settings-slice.test.ts), and what a project's
 * change stores, when a field overrides the global default and what Reset
 * leaves (test/project-overrides.test.ts). These tests keep what needs the
 * app: the stored settings read and written through main, the panel or the
 * page swapped in for the terminal or the empty screen, the keys that move
 * between them, and what saving changes elsewhere, a launch among it.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { chooseProjectAction, expectScreen, openSession, sidebar, terminalHeader } from '../support/app';
import { launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { pressQuickAsk, refuseQuickAskHotkey, setHostStub } from '../support/main-process';
import { answerDialogs, dialogsAsked } from '../support/native-dialogs';
import { sessionItem } from '../support/session-list';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import type { Locator, Page } from '@playwright/test';

const UTRECHT = { name: 'Utrecht', latitude: 52.09, longitude: 5.12 };
const BERLIN = { name: 'Berlin', latitude: 52.52, longitude: 13.4 };

async function openGlobalSettings(page: Page) {
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  await expect(globalTitle(page)).toBeVisible();
}

/** A project's settings, from the Projects modal's ⋯ menu. */
async function openProjectSettings(page: Page, label: string) {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await chooseProjectAction(page, label, 'Project settings');
  await expect(projectSettings(page, label)).toBeVisible();
}

function globalTitle(page: Page): Locator {
  return page.getByText('Global Settings', { exact: true });
}

/** A project's settings view, on its page. */
function projectSettings(page: Page, label: string): Locator {
  return page.getByRole('region', { name: `Settings for ${label}` });
}

/** One field of a project's settings view, found through its label. */
function projectField(page: Page, label: string): Locator {
  return projectSettings(page, P.acmeApi).getByText(label, { exact: true })
    .locator("xpath=ancestor::*[contains(concat(' ', @class, ' '), ' ps-field ')][1]");
}

/**
 * One row of the global form, found through its label.
 *
 * The labels are bare spans, not `<label for>`, so this climbs from the label
 * to the nearest ancestor that holds the row's own control.
 */
function field(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=ancestor::*[.//select or .//input][1]');
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
      quickAsk: true,
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

test.describe('quick ask', () => {
  test('the switch lets go of ⌥Space and takes it back, and says when another app holds it', async ({ page, app }) => {
    /* Given */
    const label = 'Open Quick Ask with ⌥Space';
    const inUse = page.getByText('⌥Space is in use by another app', { exact: true });
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

    /* When */
    await refuseQuickAskHotkey(app, false);
    await toggle(page, label).locator('..').click();
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    await openGlobalSettings(page);
    await switchOn(page, label);
    await button(page, 'Save Settings').click();
    await expect(globalTitle(page)).toBeHidden();
    await openGlobalSettings(page);

    /* Then */
    // Switching off and on tried again, and this time the key was free.
    await expect(inUse).toHaveCount(0);
    expect(await pressQuickAsk(app)).toBe(true);
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

test.describe('project settings on the project page', () => {
  const OVERRIDES = {
    ...standardFixture(),
    settings: { preLaunchCmd: 'env SB_GLOBAL=1', permissionMode: 'plan', worktree: true },
    projectSettings: { [P.acmeApi]: { addDirs: '/proj', chrome: true } },
  };
  test.use({ fixture: OVERRIDES });

  test('shows every field at the value sessions launch with, and which ones override the global default', async ({ page }) => {
    /* When */
    await openProjectSettings(page, P.acmeApi);

    /* Then */
    const view = projectSettings(page, P.acmeApi);
    await expect(view).toBeFocused();
    await expect(view.getByRole('heading', { level: 1 })).toHaveText(`Settings · ${P.acmeApi}`);
    // Inherited: the global value, the same as global.
    await expect(view.getByRole('radio', { name: 'Plan', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(projectField(page, 'Permission mode')).toContainText('Same as global.');
    await expect(view.getByLabel('Before Claude starts')).toHaveValue('env SB_GLOBAL=1');
    await expect(projectField(page, 'Before Claude starts')).toContainText('Same as global.');
    await expect(view.getByRole('switch', { name: 'Start new sessions in a worktree' })).toHaveAttribute('aria-checked', 'true');
    // Overridden: the project's value, and the global one it replaces.
    await expect(view.getByLabel('Extra directories')).toHaveValue('/proj');
    await expect(projectField(page, 'Extra directories')).toContainText('Overrides the global default (none).');
    await expect(view.getByRole('switch', { name: 'Chrome' })).toHaveAttribute('aria-checked', 'true');
    await expect(projectField(page, 'Chrome')).toContainText('Overrides the global default (off).');
    // The application settings are global only, and the old panel stays shut.
    for (const label of ['Quick Session Folder', 'Terminal Theme', 'City', 'Version']) {
      await expect(page.getByText(label, { exact: true })).toHaveCount(0);
    }
    await expect(globalTitle(page)).toBeHidden();
  });

  test('a change saves at once, and the next session started in the project launches with it', async ({ page, home }) => {
    /* Given */
    await openProjectSettings(page, P.acmeApi);
    const view = projectSettings(page, P.acmeApi);
    const saved = view.getByText('Saved · applies to new sessions', { exact: true });
    await expect(saved).toHaveCount(0);

    /* When */
    await view.getByRole('radio', { name: 'Accept edits', exact: true }).click();

    /* Then */
    await expect(saved).toBeVisible();
    await expect(projectField(page, 'Permission mode')).toContainText('Overrides the global default (Plan).');
    await expect.poll(() => readSetting(page, 'project:' + home.projectPath(P.acmeApi)))
      .toEqual({ addDirs: '/proj', chrome: true, permissionMode: 'acceptEdits' });

    /* When */
    // Back to the global value: no longer the project's own.
    await view.getByRole('switch', { name: 'Chrome' }).click();
    await view.getByLabel('Extra directories').fill('/a, /b');
    await view.getByLabel('Extra directories').press('Enter');

    /* Then */
    await expect(projectField(page, 'Chrome')).toContainText('Same as global.');
    await expect.poll(() => readSetting(page, 'project:' + home.projectPath(P.acmeApi)))
      .toEqual({ addDirs: '/a, /b', permissionMode: 'acceptEdits' });
    // Global settings are untouched.
    expect(await readSetting(page, 'global')).toMatchObject({ preLaunchCmd: 'env SB_GLOBAL=1', permissionMode: 'plan', worktree: true });

    /* When */
    await view.getByLabel('Before Claude starts').fill('env SB_PROJECT=1');
    // ⌘[ with the edit still in the box: it is stored as the view closes.
    await page.keyboard.press('Meta+BracketLeft');

    /* Then */
    const overview = page.getByRole('region', { name: 'Project ' + P.acmeApi });
    await expect(overview).toBeFocused();
    await expect.poll(async () => (await readSetting(page, 'project:' + home.projectPath(P.acmeApi)))?.preLaunchCmd)
      .toBe('env SB_PROJECT=1');

    /* When */
    const before = launchedKeys(home);
    await overview.getByRole('button', { name: 'New session', exact: true }).click();

    /* Then */
    const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
    const argv = launch.argv.join(' ');
    expect(argv).toContain('--permission-mode acceptEdits');
    expect(argv).toContain('--add-dir /a --add-dir /b');
    expect(argv).not.toContain('--chrome');
  });

  test('Reset to global settings drops every override', async ({ page, home }) => {
    /* Given */
    await openProjectSettings(page, P.acmeApi);
    const view = projectSettings(page, P.acmeApi);
    const reset = view.getByRole('button', { name: 'Reset to global settings', exact: true });

    /* When */
    await reset.click();

    /* Then */
    await expect(view.getByLabel('Extra directories')).toHaveValue('');
    await expect(view.getByRole('switch', { name: 'Chrome' })).toHaveAttribute('aria-checked', 'false');
    for (const label of ['Permission mode', 'Skip permission prompts', 'Start new sessions in a worktree', 'Chrome', 'Before Claude starts', 'Extra directories']) {
      await expect(projectField(page, label)).toContainText('Same as global.');
    }
    await expect(reset).toBeDisabled();
    await expect.poll(() => readSetting(page, 'project:' + home.projectPath(P.acmeApi))).toEqual({});
  });

  test('the header’s Settings and ⌘, open it from the page, ⌘[ goes back, and Esc closes the page', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await sessionItem(page, S.loginFix).getByTestId('project-link').click();
    const overview = page.getByRole('region', { name: 'Project ' + P.acmeApi });
    await expect(overview).toBeFocused();

    /* When */
    await overview.getByRole('button', { name: 'Settings', exact: true }).click();

    /* Then */
    await expect(projectSettings(page, P.acmeApi)).toBeFocused();

    /* When */
    await projectSettings(page, P.acmeApi).getByRole('button', { name: `Back to ${P.acmeApi} (⌘[)` }).click();

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

  test('Hide project asks first, then hides it and shows the empty screen', async ({ page, home }) => {
    /* Given */
    await openProjectSettings(page, P.acmeApi);
    const hide = projectSettings(page, P.acmeApi).getByRole('button', { name: 'Hide project', exact: true });
    await answerDialogs(page, false);

    /* When */
    await hide.click();

    /* Then */
    expect(await dialogsAsked(page)).toEqual([
      `Hide ${P.acmeApi}?\n\nSession files are not deleted. Add the folder again to bring it back.`,
    ]);
    await expect(projectSettings(page, P.acmeApi)).toBeVisible();

    /* When */
    await answerDialogs(page, true);
    await hide.click();

    /* Then */
    await expect(projectSettings(page, P.acmeApi)).toHaveCount(0);
    await expect(emptyScreen(page)).toBeVisible();
    await expect.poll(async () => page.evaluate(async (projectPath) => {
      const projects = await window.api.getProjects(false);
      return projects.some(project => project.projectPath === projectPath);
    }, home.projectPath(P.acmeApi))).toBe(false);
    await expect(sidebar(page).getByText(LABEL.loginFix, { exact: true })).toHaveCount(0);
  });

  forEachAppearance(() => {
    test('project settings', async ({ page }) => {
      /* When */
      await openProjectSettings(page, P.acmeApi);

      /* Then */
      await expect(projectSettings(page, P.acmeApi).getByLabel('Extra directories')).toHaveValue('/proj');
      await expectScreen(page, 'settings-project');
    });
  });
});

forEachAppearance(() => {
  test('global settings', async ({ page }) => {
    /* When */
    await openGlobalSettings(page);

    /* Then */
    await expectScreen(page, 'settings-global');
  });
});
