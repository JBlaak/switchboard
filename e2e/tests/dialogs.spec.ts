/**
 * The modal dialogs: the project picker, adding a project (local and remote)
 * and resuming a session with a different configuration.
 *
 * What the dialogs decide on their own — the picker's ranking, highlight and
 * counts, the add form's blank-field rules, the permission grid and the argv a
 * resume is made with — is unit tested (test/dialogs*.test.ts). These walk
 * each dialog through the app: the keys and clicks reach it, and what it asks
 * main for comes back.
 */
import fs from 'node:fs';
import { test, expect, forEachAppearance } from '../support/test';
import { dialog, expectScreen, rowButton, sessionRow, terminalStatus } from '../support/app';
import { fakeClaude, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { failStopSession, setHostStub } from '../support/main-process';
import { answerDialogs, dialogsShown } from '../support/native-dialogs';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import type { Locator, Page } from '@playwright/test';

function openPicker(page: Page) {
  return page.getByRole('button', { name: 'New session', exact: true }).click();
}

function openAddProject(page: Page) {
  return page.getByRole('button', { name: 'Add project', exact: true }).click();
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

/** A picker row's name; `rowButton` climbs from it to the row's buttons. */
function pickerRow(picker: Locator, name: string | RegExp) {
  return picker.getByText(name, { exact: true });
}

/** A picker row as a whole, for what it shows beside the name. */
function pickerRowBox(picker: Locator, name: string | RegExp) {
  return pickerRow(picker, name).locator('xpath=ancestor::*[.//button][1]');
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
    await openPicker(page);
    await expect(dialog(page, 'New Session').getByText('Development/acme-api', { exact: true })).toBeVisible();

    /* Then */
    await expectScreen(page, 'dialog-project-picker', { soft: true });

    /* When */
    await page.keyboard.press('Escape');
    await openAddProject(page);
    await expect(dialog(page, 'Add Project')).toBeVisible();

    /* Then */
    await expectScreen(page, 'dialog-add-project-local', { soft: true });

    /* When */
    await dialog(page, 'Add Project').getByRole('button', { name: 'Remote (SSH)', exact: true }).click();
    await expect(dialog(page, 'Add Project').getByPlaceholder('host or IP')).toBeVisible();

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

test.describe('project picker', () => {
  test.use({
    fixture: {
      ...standardFixture(),
      projectSettings: { [P.webDashboard]: { permissionMode: 'plan', chrome: true, addDirs: '/opt/shared' } },
    },
  });

  test('filters as you type, closes on Escape or the backdrop, and launches from the keys or the pointer', async ({ page, home }) => {
    /* Given */
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    const filter = picker.getByPlaceholder('Filter projects...');
    await expect(pickerRow(picker, P.acmeApi)).toBeVisible();

    /* When */
    await page.keyboard.type('dash');

    /* Then */
    await expect(pickerRow(picker, P.webDashboard)).toBeVisible();
    await expect(pickerRow(picker, P.acmeApi)).toHaveCount(0);

    /* When */
    await page.getByRole('heading', { name: 'New Session' }).click();

    /* Then */
    await expect(picker).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(picker).toHaveCount(0);
    // Focus is not handed back to what had it before the dialog opened.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

    /* When */
    await openPicker(page);
    await expect(filter).toBeFocused();
    await page.mouse.click(4, 4);

    /* Then */
    await expect(picker).toHaveCount(0);

    /* When */
    await openPicker(page);
    await expect(pickerRow(picker, P.notes)).toBeVisible();
    await page.keyboard.press('ArrowUp');

    /* Then */
    await expect(filter).toBeFocused();

    /* When */
    let before = launchedKeys(home);
    await page.keyboard.press('Enter');

    /* Then */
    await expect(picker).toHaveCount(0);
    // ArrowUp from the top wrapped to the bottom row.
    const notes = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(notes.cwd).toBe(home.projectPath(P.notes));

    /* When */
    await openPicker(page);
    await pickerRow(picker, P.webDashboard).hover();
    before = launchedKeys(home);
    await page.keyboard.press('Enter');

    /* Then */
    await expect(picker).toHaveCount(0);
    const dashboard = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(dashboard.cwd).toBe(home.projectPath(P.webDashboard));
    expect(dashboard.argv).toEqual(expect.arrayContaining(
      ['--permission-mode', 'plan', '--chrome', '--add-dir', '/opt/shared']));

    /* When */
    await openPicker(page);

    /* Then */
    await expect(pickerRowBox(picker, P.notes).getByText('1 running', { exact: true })).toBeVisible();
    await expect(pickerRowBox(picker, P.webDashboard).getByText('1 running', { exact: true })).toBeVisible();
    // Archived sessions are not counted.
    await expect(pickerRowBox(picker, P.acmeApi).getByText('6 sessions', { exact: true })).toBeVisible();
  });

  test('row actions ask first, change the projects in place, and never launch', async ({ page, app, home }) => {
    /* Given */
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await expect(pickerRow(picker, REMOTE_NAME)).toBeVisible();
    const before = launchedKeys(home);

    /* When */
    await answerDialogs(page, false);
    await rowButton(pickerRow(picker, REMOTE_NAME), 'Remove remote project').click();

    /* Then */
    await settle(page);
    await expect(pickerRow(picker, REMOTE_NAME)).toBeVisible();
    expect(await projectPaths(page)).toContain(REMOTE_PATH);

    /* When */
    await answerDialogs(page, true);
    await rowButton(pickerRow(picker, REMOTE_NAME), 'Remove remote project').click();

    /* Then */
    await expect(pickerRow(picker, REMOTE_NAME)).toHaveCount(0);
    await expect(pickerRow(picker, P.acmeApi)).toBeVisible();
    expect(await projectPaths(page)).not.toContain(REMOTE_PATH);

    /* When */
    await answerDialogs(page, true);
    await rowButton(pickerRow(picker, WORKTREE_NAME), 'Hide worktree').click();

    /* Then */
    await expect(pickerRow(picker, WORKTREE_NAME)).toHaveCount(0);
    expect(await projectPaths(page)).not.toContain(home.projectPath(P.goneParser));

    /* When */
    await answerDialogs(page, true);
    await rowButton(pickerRow(picker, P.webDashboard), 'Archive all sessions in this project').click();

    /* Then */
    await expect.poll(() => page.evaluate(async (path) => {
      const project = (await window.api.getProjects(true)).find(p => p.projectPath === path);
      return project?.sessions.every(s => s.archived);
    }, home.projectPath(P.webDashboard))).toBe(true);
    await expect(picker).toBeVisible();
    await expect(pickerRowBox(picker, P.webDashboard).getByText('0 sessions', { exact: true })).toBeVisible();
    await expect(pickerRowBox(picker, P.acmeApi).getByText('6 sessions', { exact: true })).toBeVisible();

    /* When */
    await failStopSession(app, 'still running');
    const archivedBefore = await archivedCount(page, home.projectPath(P.acmeApi));
    await answerDialogs(page, true);
    const prompts = async () => (await dialogsShown(page)).map(shown => shown.type);
    await rowButton(pickerRow(picker, P.acmeApi), 'Archive all sessions in this project').click();

    /* Then */
    // Archive all stops at the first session it cannot stop, and says so once.
    await expect.poll(prompts).toEqual(['confirm', 'alert']);
    await settle(page);
    expect(await prompts()).toEqual(['confirm', 'alert']);
    expect(await archivedCount(page, home.projectPath(P.acmeApi))).toBe(archivedBefore);

    /* When */
    await rowButton(pickerRow(picker, P.acmeApi), 'Project settings').click();

    /* Then */
    await expect(picker).toHaveCount(0);
    await expect(page.getByText(`Project Settings — ${P.acmeApi}`, { exact: true })).toBeVisible();
    await settle(page);
    expect(launchedKeys(home)).toEqual(before);
  });
});

test.describe('add project', () => {
  test('adds a local folder, after Cancel, a blank path, a missing one and a cancelled Browse', async ({ page, app, home }) => {
    /* Given */
    const target = home.projectPath('Development/brand-new');
    fs.mkdirSync(target, { recursive: true });
    const add = dialog(page, 'Add Project');
    const path = add.getByPlaceholder('/path/to/project');

    /* When */
    await openAddProject(page);
    await path.fill('/anything');
    await add.getByRole('button', { name: 'Cancel', exact: true }).click();

    /* Then */
    await expect(add).toHaveCount(0);

    /* When */
    await openAddProject(page);
    await expect(path).toBeFocused();
    await add.getByRole('button', { name: 'Add', exact: true }).click();

    /* Then */
    await expect(add.getByText('Please enter a folder path.')).toBeVisible();

    /* When */
    await add.getByRole('button', { name: 'Remote (SSH)', exact: true }).click();

    /* Then */
    // Each tab's first field takes the focus, and a switch hides the error.
    await expect(add.getByPlaceholder('user')).toBeFocused();
    await expect(add.getByText('Please enter a folder path.')).toBeHidden();
    await expect(path).toBeHidden();

    /* When */
    await add.getByRole('button', { name: 'Local folder', exact: true }).click();

    /* Then */
    await expect(path).toBeFocused();
    await expect(add.getByPlaceholder('host or IP')).toBeHidden();

    /* When */
    await path.fill(home.projectPath('Development/does-not-exist'));
    await page.keyboard.press('Enter');

    /* Then */
    await expect(add.getByText('Path does not exist', { exact: true })).toBeVisible();
    await expect(add).toBeVisible();

    /* When */
    // The folder picker's stub answers nothing, as a cancelled picker does.
    await path.fill('/typed/by/hand');
    await add.getByRole('button', { name: 'Browse', exact: true }).click();

    /* Then */
    await settle(page);
    await expect(path).toHaveValue('/typed/by/hand');

    /* When */
    await setHostStub(app, 'browseFolder', target);
    await add.getByRole('button', { name: 'Browse', exact: true }).click();

    /* Then */
    await expect(path).toHaveValue(target);

    /* When */
    await add.getByRole('button', { name: 'Add', exact: true }).click();

    /* Then */
    await expect(add).toHaveCount(0);
    await openPicker(page);
    await expect(dialog(page, 'New Session').getByText('Development/brand-new', { exact: true })).toBeVisible();
  });

  test('adds a remote, after a blank host and a duplicate, and opening it dials it', async ({ page, home }) => {
    /* Given */
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByRole('button', { name: 'Remote (SSH)', exact: true }).click();

    /* When */
    await add.getByPlaceholder('user').fill('deploy');
    await page.keyboard.press('Enter');

    /* Then */
    await expect(add.getByText('Please enter a username and host.')).toBeVisible();

    /* When */
    await add.getByPlaceholder('user').fill('joris');
    await add.getByPlaceholder('host or IP').fill('buildbox.local');
    await add.getByPlaceholder(/^working directory/).fill('~/apps/api');
    await add.getByRole('button', { name: 'Add', exact: true }).click();

    /* Then */
    await expect(add.getByText('This remote is already added.')).toBeVisible();
    await expect(add).toBeVisible();

    /* When */
    await add.getByPlaceholder('user').fill('deploy');
    await add.getByPlaceholder('host or IP').fill('staging.example.com');
    await add.getByPlaceholder('22', { exact: true }).fill('2222');
    await add.getByPlaceholder(/^working directory/).fill('');
    await add.getByRole('button', { name: 'Add', exact: true }).click();

    /* Then */
    await expect(add).toHaveCount(0);
    expect(await projectPaths(page)).toContain('ssh://deploy@staging.example.com:2222');

    /* When */
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    const before = launchedKeys(home);
    // The row reads "deploy@staging.example.com" followed by an "SSH" badge.
    await pickerRow(picker, /^deploy@staging\.example\.com/).click();

    /* Then */
    await expect(picker).toHaveCount(0);
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
