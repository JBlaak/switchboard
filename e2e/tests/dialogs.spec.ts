/**
 * The modal dialogs: the Projects modal (starting a session, a project's ⋯
 * menu, adding a local folder or a remote) and resuming a session with a
 * different configuration.
 *
 * What the dialogs decide on their own — the modal's ranking, rows, keys and
 * folder check, the add form's blank-field rules, the permission grid and the
 * argv a resume is made with — is unit tested (test/dialogs*.test.ts,
 * test/projects-modal.test.ts, test/project-folder-service.test.ts). These
 * walk each dialog through the app: the keys and clicks reach it, and what it
 * asks main for comes back.
 */
import fs from 'node:fs';
import { test, expect, forEachAppearance } from '../support/test';
import { chooseProjectAction, dialog, expectScreen, rowButton, sessionRow, terminalStatus } from '../support/app';
import { fakeClaude, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { failStopSession, setHostStub } from '../support/main-process';
import { answerDialogs, dialogsShown } from '../support/native-dialogs';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import type { Locator, Page } from '@playwright/test';

function openProjects(page: Page) {
  return page.getByRole('button', { name: 'Projects', exact: true }).click();
}

function projectsModal(page: Page) {
  return dialog(page, 'Projects');
}

function filter(page: Page) {
  return projectsModal(page).getByLabel('Filter projects');
}

async function openResumeWithConfig(page: Page, label: string) {
  const row = sessionRow(page, label);
  await row.hover();
  await rowButton(row, 'Resume with config').click();
}

/** Take the focus off whatever has it, so a stray Enter cannot click a button. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** A modal row's name; `rowButton` climbs from it to the highlighted row's buttons. */
function pickerRow(modal: Locator, name: string | RegExp) {
  return modal.getByText(name, { exact: true });
}

/**
 * A modal row as a whole, for what it shows beside the name. Only the
 * highlighted row has buttons, so this climbs to the row by its class.
 */
function pickerRowBox(modal: Locator, name: string | RegExp) {
  return pickerRow(modal, name).locator('xpath=ancestor::div[contains(@class, "project-picker-row")][1]');
}

/** Give something that must not happen the time it would have taken to happen. */
function settle(page: Page) {
  return page.waitForTimeout(500);
}

function projectPaths(page: Page) {
  return page.evaluate(async () => (await window.api.getProjects(true)).map(p => p.projectPath));
}

/** How many of a project's sessions main has archived. */
function archivedCount(page: Page, projectPath: string) {
  return page.evaluate(async (path) => {
    const project = (await window.api.getProjects(true)).find(p => p.projectPath === path);
    return project?.sessions.filter(s => s.archived).length;
  }, projectPath);
}

const REMOTE_PATH = 'ssh://joris@buildbox.local/~/apps/api';
/** The remote's name is followed by its "SSH" badge, inside the same element. */
const REMOTE_NAME = /^joris@buildbox\.local\/api/;
const WORKTREE_NAME = 'Development/old-parser ⎇ streaming';

forEachAppearance(() => {
  test('dialog screens', async ({ page }) => {
    /* When */
    await openProjects(page);
    await expect(projectsModal(page).getByText('Development/acme-api', { exact: true })).toBeVisible();

    /* Then */
    await expectScreen(page, 'dialog-project-picker', { soft: true });

    /* When */
    await page.keyboard.press('Meta+Period');
    await expect(page.getByRole('menu')).toBeVisible();

    /* Then */
    await expectScreen(page, 'dialog-project-menu', { soft: true });

    /* When */
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+Enter');
    await expect(dialog(page, /Add project$/)).toBeVisible();

    /* Then */
    await expectScreen(page, 'dialog-add-project-local', { soft: true });

    /* When */
    await dialog(page, /Add project$/).getByRole('tab', { name: 'Remote (SSH)' }).click();
    await expect(dialog(page, /Add project$/).getByPlaceholder('host or IP')).toBeVisible();

    /* Then */
    await expectScreen(page, 'dialog-add-project-remote', { soft: true });

    /* When */
    await page.keyboard.press('Escape');
    await openResumeWithConfig(page, LABEL.releaseNotes);
    await expect(dialog(page, /^Resume Session/)).toBeVisible();

    /* Then */
    await expectScreen(page, 'dialog-resume-with-config', { soft: true });
  });
});

test.describe('projects modal', () => {
  test.use({
    fixture: {
      ...standardFixture(),
      projectSettings: { [P.webDashboard]: { permissionMode: 'plan', chrome: true, addDirs: '/opt/shared' } },
    },
  });

  test('filters as you type, closes on Escape or the backdrop, and launches from the keys or the pointer', async ({ page, home }) => {
    /* Given */
    await openProjects(page);
    const modal = projectsModal(page);
    await expect(pickerRow(modal, P.acmeApi)).toBeVisible();

    /* When */
    await page.keyboard.type('dash');

    /* Then */
    await expect(pickerRow(modal, P.webDashboard)).toBeVisible();
    await expect(pickerRow(modal, P.acmeApi)).toHaveCount(0);
    // Add project… stays the last row, whatever the filter.
    await expect(pickerRow(modal, 'Add project…')).toBeVisible();

    /* When */
    await page.getByRole('heading', { name: 'Projects' }).click();

    /* Then */
    await expect(modal).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(modal).toHaveCount(0);
    // On the empty screen the focus goes back to Ask Patch's box (#135).
    await expect(page.getByTestId('ask-box')).toBeFocused();

    /* When */
    await openProjects(page);
    await expect(filter(page)).toBeFocused();
    await page.mouse.click(4, 4);

    /* Then */
    await expect(modal).toHaveCount(0);

    /* When */
    await openProjects(page);
    await expect(pickerRow(modal, P.notes)).toBeVisible();
    // Up from the top wraps to Add project…, and once more to the last project.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');

    /* Then */
    await expect(filter(page)).toBeFocused();

    /* When */
    let before = launchedKeys(home);
    await page.keyboard.press('Enter');

    /* Then */
    await expect(modal).toHaveCount(0);
    const notes = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(notes.cwd).toBe(home.projectPath(P.notes));

    /* When */
    await openProjects(page);
    await pickerRow(modal, P.webDashboard).hover();
    before = launchedKeys(home);
    await page.keyboard.press('Enter');

    /* Then */
    await expect(modal).toHaveCount(0);
    const dashboard = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(dashboard.cwd).toBe(home.projectPath(P.webDashboard));
    expect(dashboard.argv).toEqual(expect.arrayContaining(
      ['--permission-mode', 'plan', '--chrome', '--add-dir', '/opt/shared']));

    /* When */
    await openProjects(page);

    /* Then */
    await expect(pickerRowBox(modal, P.notes).getByText('1 running', { exact: true })).toBeVisible();
    await expect(pickerRowBox(modal, P.webDashboard).getByText('1 running', { exact: true })).toBeVisible();
    // Archived sessions are not counted.
    await expect(pickerRowBox(modal, P.acmeApi).getByText('6 sessions', { exact: true })).toBeVisible();
  });

  test('the ⋯ menu asks first, changes the projects in place, and never launches', async ({ page, app, home }) => {
    /* Given */
    await openProjects(page);
    const modal = projectsModal(page);
    await expect(pickerRow(modal, REMOTE_NAME)).toBeVisible();
    const before = launchedKeys(home);

    /* When */
    // Only the highlighted row has buttons: the old per-row icons are gone.
    await pickerRow(modal, P.acmeApi).hover();
    await page.keyboard.press('Meta+Period');

    /* Then */
    await expect(modal.getByRole('button', { name: /^More for / })).toHaveCount(1);
    await expect(page.getByRole('menuitem')).toHaveText(
      ['Project settings', 'Open on GitHub', /^Archive all \d+ sessions?…$/, 'Hide project']);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    // Esc puts the menu away and leaves the modal open.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(modal).toBeVisible();

    /* When */
    await answerDialogs(page, false);
    await chooseProjectAction(page, REMOTE_NAME, 'Remove project');

    /* Then */
    await settle(page);
    await expect(pickerRow(modal, REMOTE_NAME)).toBeVisible();
    expect(await projectPaths(page)).toContain(REMOTE_PATH);

    /* When */
    await answerDialogs(page, true);
    await chooseProjectAction(page, REMOTE_NAME, 'Remove project');

    /* Then */
    await expect(pickerRow(modal, REMOTE_NAME)).toHaveCount(0);
    await expect(pickerRow(modal, P.acmeApi)).toBeVisible();
    expect(await projectPaths(page)).not.toContain(REMOTE_PATH);

    /* When */
    await answerDialogs(page, true);
    await chooseProjectAction(page, WORKTREE_NAME, 'Hide project');

    /* Then */
    await expect(pickerRow(modal, WORKTREE_NAME)).toHaveCount(0);
    expect(await projectPaths(page)).not.toContain(home.projectPath(P.goneParser));

    /* When */
    await answerDialogs(page, true);
    await chooseProjectAction(page, P.webDashboard, /^Archive all /);

    /* Then */
    await expect.poll(() => page.evaluate(async (path) => {
      const project = (await window.api.getProjects(true)).find(p => p.projectPath === path);
      return project?.sessions.every(s => s.archived);
    }, home.projectPath(P.webDashboard))).toBe(true);
    await expect(modal).toBeVisible();
    await expect(pickerRowBox(modal, P.webDashboard).getByText('0 sessions', { exact: true })).toBeVisible();
    await expect(pickerRowBox(modal, P.acmeApi).getByText('6 sessions', { exact: true })).toBeVisible();

    /* When */
    await failStopSession(app, 'still running');
    const archivedBefore = await archivedCount(page, home.projectPath(P.acmeApi));
    await answerDialogs(page, true);
    const prompts = async () => (await dialogsShown(page)).map(shown => shown.type);
    await chooseProjectAction(page, P.acmeApi, /^Archive all /);

    /* Then */
    // Archive all stops at the first session it cannot stop, and says so once.
    await expect.poll(prompts).toEqual(['confirm', 'alert']);
    await settle(page);
    expect(await prompts()).toEqual(['confirm', 'alert']);
    expect(await archivedCount(page, home.projectPath(P.acmeApi))).toBe(archivedBefore);

    /* When */
    await chooseProjectAction(page, P.acmeApi, 'Project settings');

    /* Then */
    await expect(modal).toHaveCount(0);
    await expect(page.getByText(`Project Settings — ${P.acmeApi}`, { exact: true })).toBeVisible();
    await settle(page);
    expect(launchedKeys(home)).toEqual(before);
  });
});

test.describe('adding a project', () => {
  test('⌘A, paste a folder path, ↵: the folder is added and highlighted, ready to start in', async ({ page, home }) => {
    /* Given */
    const target = home.projectPath('Development/brand-new');
    fs.mkdirSync(target, { recursive: true });
    await blur(page);
    await page.keyboard.press('Meta+a');
    const modal = projectsModal(page);

    /* When */
    await filter(page).fill(home.projectPath('Development/bran'));
    await page.keyboard.press('Tab');

    /* Then */
    // ⇥ completes the path, and the folder is checked as it stands.
    await expect(filter(page)).toHaveValue(target + '/');
    await expect(modal.getByText('Folder, not a git repository · not added yet', { exact: true })).toBeVisible();

    /* When */
    await page.keyboard.press('Enter');

    /* Then */
    await expect(filter(page)).toHaveValue('');
    await expect(rowButton(pickerRow(modal, 'Development/brand-new'), 'New session')).toBeVisible();
    expect(await projectPaths(page)).toContain(target);

    /* When */
    const before = launchedKeys(home);
    await page.keyboard.press('Enter');

    /* Then */
    await expect(modal).toHaveCount(0);
    const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(launch.cwd).toBe(target);
  });

  test('the add step: back with the search kept, a blank path, a missing one, Browse, then Add', async ({ page, app, home }) => {
    /* Given */
    const target = home.projectPath('Development/brand-new');
    fs.mkdirSync(target, { recursive: true });
    await openProjects(page);
    const add = dialog(page, /Add project$/);
    const path = add.getByPlaceholder('/path/to/project');
    await filter(page).fill('acme');

    /* When */
    await page.keyboard.press('Meta+Enter');

    /* Then */
    await expect(path).toBeFocused();

    /* When */
    await page.keyboard.press('Meta+BracketLeft');

    /* Then */
    await expect(filter(page)).toHaveValue('acme');
    await expect(filter(page)).toBeFocused();

    /* When */
    await pickerRow(projectsModal(page), 'Add project…').click();
    await add.getByRole('button', { name: 'Add', exact: true }).click();

    /* Then */
    await expect(add.getByText('Please enter a folder path.')).toBeVisible();

    /* When */
    await add.getByRole('tab', { name: 'Remote (SSH)' }).click();

    /* Then */
    // Each tab's first field takes the focus, and a switch hides the error.
    await expect(add.getByPlaceholder('user')).toBeFocused();
    await expect(add.getByText('Please enter a folder path.')).toBeHidden();
    await expect(path).toBeHidden();

    /* When */
    await add.getByRole('tab', { name: 'Local folder' }).click();
    await path.fill(home.projectPath('Development/does-not-exist'));

    /* Then */
    await expect(add.getByText('No folder at this path', { exact: true })).toBeVisible();

    /* When */
    await page.keyboard.press('Enter');

    /* Then */
    await expect(add.getByText('Path does not exist', { exact: true })).toBeVisible();

    /* When */
    // The folder picker's stub answers nothing, as a cancelled picker does.
    await path.fill('/typed/by/hand');
    await add.getByRole('button', { name: 'Browse…', exact: true }).click();

    /* Then */
    await settle(page);
    await expect(path).toHaveValue('/typed/by/hand');

    /* When */
    await setHostStub(app, 'browseFolder', target);
    await add.getByRole('button', { name: 'Browse…', exact: true }).click();

    /* Then */
    await expect(path).toHaveValue(target);
    await expect(add.getByText('Folder exists', { exact: true })).toBeVisible();
    await expect(add.getByText('Not a git repository', { exact: true })).toBeVisible();

    /* When */
    await add.getByRole('button', { name: 'Add', exact: true }).click();

    /* Then */
    // Back on the list, with the new project highlighted.
    await expect(filter(page)).toHaveValue('');
    await expect(rowButton(pickerRow(projectsModal(page), 'Development/brand-new'), 'New session')).toBeVisible();
  });

  test('user@host opens the SSH tab filled in; a duplicate is refused, a new one added and dialled', async ({ page, home }) => {
    /* Given */
    await openProjects(page);
    const modal = projectsModal(page);
    const add = dialog(page, /Add project$/);

    /* When */
    await filter(page).fill('deploy@');

    /* Then */
    await expect(modal.getByText(/^Add remote /)).toHaveCount(0);

    /* When */
    await filter(page).fill('joris@buildbox.local');
    await page.keyboard.press('Enter');

    /* Then */
    await expect(add.getByRole('tab', { name: 'Remote (SSH)' })).toHaveAttribute('aria-selected', 'true');
    await expect(add.getByPlaceholder('user')).toHaveValue('joris');
    await expect(add.getByPlaceholder('host or IP')).toHaveValue('buildbox.local');

    /* When */
    await add.getByPlaceholder(/^working directory/).fill('~/apps/api');
    await add.getByRole('button', { name: 'Add', exact: true }).click();

    /* Then */
    await expect(add.getByText('This remote is already added.')).toBeVisible();

    /* When */
    await add.getByPlaceholder('user').fill('');
    await page.keyboard.press('Enter');

    /* Then */
    await expect(add.getByText('Please enter a username and host.')).toBeVisible();

    /* When */
    await add.getByPlaceholder('user').fill('deploy');
    await add.getByPlaceholder('host or IP').fill('staging.example.com');
    await add.getByPlaceholder('22', { exact: true }).fill('2222');
    await add.getByPlaceholder(/^working directory/).fill('');
    await page.keyboard.press('Enter');

    /* Then */
    expect(await projectPaths(page)).toContain('ssh://deploy@staging.example.com:2222');
    await expect(rowButton(pickerRow(modal, /^deploy@staging\.example\.com/), 'New session')).toBeVisible();

    /* When */
    const before = launchedKeys(home);
    await pickerRow(modal, /^deploy@staging\.example\.com/).click();

    /* Then */
    await expect(modal).toHaveCount(0);
    await waitForNewLaunch(home, 'ssh', before);
  });
});

test.describe('resume with config', () => {
  test.use({
    fixture: {
      ...standardFixture(),
      projectSettings: {
        [P.acmeApi]: { permissionMode: 'plan', chrome: true, preLaunchCmd: 'env SB_E2E=1', addDirs: '/opt/a, /opt/b' },
      },
    },
  });

  /** A permission option, by its name (the button's text starts with it). */
  function option(resume: Locator, label: string) {
    return resume.getByRole('button', { name: new RegExp('^' + label) });
  }

  test('opens on the effective settings, closes without resuming, and resumes with what was changed', async ({ page, home }) => {
    /* Given */
    const resume = dialog(page, /^Resume Session/);
    const claude = fakeClaude(home, S.releaseNotes);

    /* When */
    await openResumeWithConfig(page, LABEL.releaseNotes);

    /* Then */
    await expect(resume.getByRole('heading')).toHaveText(`Resume Session — ${LABEL.releaseNotes}`);
    await expect(resume.getByRole('checkbox')).toBeChecked();
    await expect(resume.getByPlaceholder('e.g. aws-vault exec profile --')).toHaveValue('env SB_E2E=1');
    await expect(resume.getByPlaceholder('/path/to/dir1, /path/to/dir2')).toHaveValue('/opt/a, /opt/b');
    await expect(resume.getByText(/worktree/i)).toHaveCount(0);

    /* When */
    await resume.getByRole('button', { name: 'Cancel', exact: true }).click();

    /* Then */
    await expect(resume).toHaveCount(0);

    /* When */
    await openResumeWithConfig(page, LABEL.releaseNotes);
    await expect(resume).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(resume).toHaveCount(0);
    await blur(page);
    await page.keyboard.press('Enter');

    /* Then */
    // Neither Cancel nor Escape resumed, and Escape left no key handler behind.
    await settle(page);
    expect(claude.launches()).toHaveLength(0);

    /* When */
    await openResumeWithConfig(page, LABEL.releaseNotes);
    await resume.getByPlaceholder('e.g. aws-vault exec profile --').click();
    await page.keyboard.press('Enter');

    /* Then */
    // Enter does not submit from a text field in this dialog.
    await settle(page);
    await expect(resume).toBeVisible();

    /* When */
    // The checkbox itself is hidden behind its slider; the label is what takes the click.
    await resume.getByRole('checkbox').locator('..').click();
    await expect(resume.getByRole('checkbox')).not.toBeChecked();
    await resume.getByPlaceholder('/path/to/dir1, /path/to/dir2').fill('');
    await option(resume, 'Accept Edits').click();
    await blur(page);
    await page.keyboard.press('Enter');

    /* Then */
    await expect(resume).toHaveCount(0);
    await expect(terminalStatus(page)).toHaveText('Running');
    const { argv } = await claude.launched();
    expect(argv).toEqual(expect.arrayContaining(['--resume', S.releaseNotes, '--permission-mode', 'acceptEdits']));
    expect(argv).not.toContain('--chrome');
    expect(argv).not.toContain('--add-dir');
  });
});
