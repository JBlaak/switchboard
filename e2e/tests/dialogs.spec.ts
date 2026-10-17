/**
 * The modal dialogs: the project picker, adding a project (local and remote)
 * and resuming a session with a different configuration.
 */
import fs from 'node:fs';
import { test, expect, forEachAppearance } from '../support/test';
import { dialog, expectScreen, openSession, rowButton, sessionRow, terminalStatus } from '../support/app';
import { fakeClaude, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { failStopSession, setHostStub } from '../support/main-process';
import { answerDialogs, dialogsShown } from '../support/native-dialogs';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import type { Locator, Page } from '@playwright/test';
import type { FixtureHome } from '../support/fixture-home';

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

test.describe('smoke', () => {
  test('the project picker filters as you type and closes on Escape', async ({ page }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await expect(picker.getByText('Development/acme-api', { exact: true })).toBeVisible();
    await expect(picker.getByText('SSH', { exact: true })).toBeVisible();

    await page.keyboard.type('dash');
    await expect(picker.getByText('Development/web-dashboard', { exact: true })).toBeVisible();
    await expect(picker.getByText('Development/acme-api', { exact: true })).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  });

  test('adds a local project', async ({ page, home }) => {
    const target = home.projectPath('Development/brand-new');
    fs.mkdirSync(target, { recursive: true });

    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add.getByText('Please enter a folder path.')).toBeVisible();

    await add.getByPlaceholder('/path/to/project').fill(target);
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add).toHaveCount(0);

    await openPicker(page);
    await expect(dialog(page, 'New Session').getByText('Development/brand-new', { exact: true })).toBeVisible();
  });

  test('adds a remote project', async ({ page }) => {
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByRole('button', { name: 'Remote (SSH)', exact: true }).click();
    await add.getByPlaceholder('user').fill('deploy');
    await add.getByPlaceholder('host or IP').fill('staging.example.com');
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add).toHaveCount(0);

    await openPicker(page);
    // The row reads "deploy@staging.example.com" followed by an "SSH" badge.
    await expect(dialog(page, 'New Session').getByText(/^deploy@staging\.example\.com/)).toBeVisible();
  });

  test('resume with config passes the chosen options to claude', async ({ page, home }) => {
    await openResumeWithConfig(page, LABEL.releaseNotes);
    const resume = dialog(page, /^Resume Session/);
    await expect(resume).toBeVisible();
    await resume.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(terminalStatus(page)).toHaveText('Running');
    const launch = await fakeClaude(home, S.releaseNotes).launched();
    expect(launch.argv).toContain('--resume');
  });
});

forEachAppearance(() => {
  test('project picker', async ({ page }) => {
    await openPicker(page);
    await expect(dialog(page, 'New Session').getByText('Development/acme-api', { exact: true })).toBeVisible();
    await expectScreen(page, 'dialog-project-picker');
  });

  test('add project, local', async ({ page }) => {
    await openAddProject(page);
    await expect(dialog(page, 'Add Project')).toBeVisible();
    await expectScreen(page, 'dialog-add-project-local');
  });

  test('add project, remote', async ({ page }) => {
    await openAddProject(page);
    await dialog(page, 'Add Project').getByRole('button', { name: 'Remote (SSH)', exact: true }).click();
    await expect(dialog(page, 'Add Project').getByPlaceholder('host or IP')).toBeVisible();
    await expectScreen(page, 'dialog-add-project-remote');
  });

  test('resume with config', async ({ page }) => {
    await openResumeWithConfig(page, LABEL.releaseNotes);
    await expect(dialog(page, /^Resume Session/)).toBeVisible();
    await expectScreen(page, 'dialog-resume-with-config');
  });
});

// ── Behaviour, pinned down ahead of the React port (#58) ──

/** Take the focus off whatever has it, so a stray Enter cannot click a button. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The picker's project names, top to bottom; each carries its full path as a title. */
function pickerNames(picker: Locator) {
  return picker.getByTitle(/./).allTextContents();
}

/**
 * A project name split into its plain and highlighted runs, the highlighted
 * ones in brackets: "Development/[acme]-api".
 */
function highlightedName(picker: Locator, projectPath: string) {
  return picker.getByTitle(projectPath, { exact: true }).evaluate(el =>
    Array.from(el.childNodes)
      .map(node => node instanceof HTMLElement ? `[${node.textContent}]` : node.textContent)
      .join(''));
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

const REMOTE_PATH = 'ssh://joris@buildbox.local/~/apps/api';
/** The remote's name is followed by its "SSH" badge, inside the same element. */
const REMOTE_NAME = /^joris@buildbox\.local\/api/;
const WORKTREE_NAME = 'Development/old-parser ⎇ streaming';

test.describe('dialog shell', () => {
  test('the overlay sits on the body, and a click on the backdrop closes it', async ({ page }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    expect(await picker.evaluate(el => el.parentElement?.parentElement === document.body)).toBe(true);

    await page.mouse.click(4, 4);
    await expect(picker).toHaveCount(0);
  });

  test('a click inside the dialog does not close it', async ({ page }) => {
    await openPicker(page);
    await page.getByRole('heading', { name: 'New Session' }).click();
    await expect(dialog(page, 'New Session')).toBeVisible();
  });

  test('Escape closes, and leaves no key handler behind', async ({ page, home }) => {
    await openResumeWithConfig(page, LABEL.releaseNotes);
    await expect(dialog(page, /^Resume Session/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page, /^Resume Session/)).toHaveCount(0);

    await blur(page);
    await page.keyboard.press('Enter');
    await settle(page);
    expect(fakeClaude(home, S.releaseNotes).launches()).toHaveLength(0);
  });

  test('Enter submits, but not from a text field unless the dialog allows it', async ({ page, home }) => {
    await openResumeWithConfig(page, LABEL.releaseNotes);
    const resume = dialog(page, /^Resume Session/);
    await resume.getByPlaceholder('e.g. aws-vault exec profile --').click();
    await page.keyboard.press('Enter');
    await settle(page);
    await expect(resume).toBeVisible();

    await blur(page);
    await page.keyboard.press('Enter');
    await expect(resume).toHaveCount(0);
    expect((await fakeClaude(home, S.releaseNotes).launched()).argv).toContain('--resume');
  });

  test('focus is not restored on close', async ({ page }) => {
    await openPicker(page);
    await expect(dialog(page, 'New Session').getByPlaceholder('Filter projects...')).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  test('icon buttons carry an instant tooltip and an accessible name', async ({ page }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    const expected: [string | RegExp, string][] = [
      [P.acmeApi, 'Project settings'],
      [P.acmeApi, 'Archive all sessions in this project'],
      [REMOTE_NAME, 'Remove remote project'],
      [WORKTREE_NAME, 'Hide worktree'],
    ];
    for (const [name, tooltip] of expected) {
      await expect(rowButton(pickerRow(picker, name), tooltip)).toHaveAttribute('data-tooltip', tooltip);
    }
  });
});

test.describe('project picker', () => {
  test('lists label matches first, then by score, then by recent activity', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await expect(pickerRow(picker, P.acmeApi)).toBeVisible();
    expect(await pickerNames(picker)).toEqual([
      'Development/acme-api',
      'Development/web-dashboard',
      'joris@buildbox.local/apiSSH',
      'Development/old-parser ⎇ streaming',
      'Documents/notes',
    ]);

    await page.keyboard.type('api');
    // The worktree's label has no "api" in it; only its full path does, so it
    // comes after both label matches.
    await expect.poll(() => pickerNames(picker)).toEqual([
      'Development/acme-api',
      'joris@buildbox.local/apiSSH',
      'Development/old-parser ⎇ streaming',
    ]);
    // A path-only match highlights nothing.
    await expect.poll(() => highlightedName(picker, home.projectPath(P.goneParser)))
      .toBe('Development/old-parser ⎇ streaming');
  });

  test('highlights the matched characters, one run per contiguous match', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await page.keyboard.type('acme');
    await expect.poll(() => highlightedName(picker, home.projectPath(P.acmeApi))).toBe('Development/[acme]-api');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('dvwb');
    await expect.poll(() => highlightedName(picker, home.projectPath(P.webDashboard)))
      .toBe('[D]e[v]elopment/[w]e[b]-dashboard');
  });

  test('says so when nothing matches', async ({ page }) => {
    await openPicker(page);
    await page.keyboard.type('zzzzqqq');
    await expect(dialog(page, 'New Session').getByText('No matching projects.')).toBeVisible();
  });

  test('ArrowUp from the top wraps to the bottom, and focus stays in the filter', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await expect(pickerRow(picker, P.notes)).toBeVisible();

    await page.keyboard.press('ArrowUp');
    await expect(picker.getByPlaceholder('Filter projects...')).toBeFocused();
    const before = launchedKeys(home);
    await page.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(launch.cwd).toBe(home.projectPath(P.notes));
  });

  test('ArrowDown past the bottom wraps to the top', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await expect(pickerRow(picker, P.notes)).toBeVisible();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
    const before = launchedKeys(home);
    await page.keyboard.press('Enter');
    const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(launch.cwd).toBe(home.projectPath(P.acmeApi));
  });

  test('a new query starts the highlight from the top again', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await page.keyboard.type('Develop');
    await expect.poll(() => pickerNames(picker)).toHaveLength(3);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('m');
    await expect.poll(() => pickerNames(picker)).toHaveLength(3);
    const before = launchedKeys(home);
    await page.keyboard.press('Enter');
    const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(launch.cwd).toBe(home.projectPath(P.acmeApi));
  });

  test('hovering a row highlights it for Enter, without taking the focus', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await pickerRow(picker, P.webDashboard).hover();
    await expect(picker.getByPlaceholder('Filter projects...')).toBeFocused();
    const before = launchedKeys(home);
    await page.keyboard.press('Enter');
    const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
    expect(launch.cwd).toBe(home.projectPath(P.webDashboard));
  });

  test('rows show an SSH badge for a remote, and how many sessions or how many are running', async ({ page, home }) => {
    await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await expect(pickerRowBox(picker, REMOTE_NAME).getByText('SSH', { exact: true })).toBeVisible();
    await expect(pickerRowBox(picker, P.acmeApi).getByText('SSH', { exact: true })).toHaveCount(0);
    await expect(pickerRowBox(picker, P.webDashboard).getByText('1 running', { exact: true })).toBeVisible();
    await expect(pickerRowBox(picker, P.notes).getByText('1 session', { exact: true })).toBeVisible();
    // Archived sessions are not counted.
    await expect(pickerRowBox(picker, P.acmeApi).getByText('6 sessions', { exact: true })).toBeVisible();
  });

  test('opening a remote row dials it', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    const before = launchedKeys(home);
    await pickerRow(picker, REMOTE_NAME).click();
    await expect(picker).toHaveCount(0);
    await waitForNewLaunch(home, 'ssh', before);
  });

  test.describe('with project defaults', () => {
    test.use({
      fixture: {
        ...standardFixture(),
        projectSettings: { [P.webDashboard]: { permissionMode: 'plan', chrome: true, addDirs: '/opt/shared' } },
      },
    });

    test('opening a row launches with the project defaults', async ({ page, home }) => {
      await openPicker(page);
      const picker = dialog(page, 'New Session');
      const before = launchedKeys(home);
      await pickerRow(picker, P.webDashboard).click();
      await expect(picker).toHaveCount(0);
      const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
      expect(launch.cwd).toBe(home.projectPath(P.webDashboard));
      expect(launch.argv).toEqual(expect.arrayContaining(
        ['--permission-mode', 'plan', '--chrome', '--add-dir', '/opt/shared']));
    });
  });

  test('settings closes the picker and opens the project settings, without launching', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    const before = launchedKeys(home);
    await rowButton(pickerRow(picker, P.acmeApi), 'Project settings').click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByText(`Project Settings — ${P.acmeApi}`, { exact: true })).toBeVisible();
    await settle(page);
    expect(launchedKeys(home)).toEqual(before);
  });

  test('remove asks first, and leaves the remote when declined', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    const before = launchedKeys(home);
    await answerDialogs(page, false);
    await rowButton(pickerRow(picker, REMOTE_NAME), 'Remove remote project').click();
    await settle(page);
    await expect(pickerRow(picker, REMOTE_NAME)).toBeVisible();
    expect(await projectPaths(page)).toContain(REMOTE_PATH);
    expect(launchedKeys(home)).toEqual(before);
  });

  test('remove forgets the remote and redraws the list in place', async ({ page }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await answerDialogs(page, true);
    await rowButton(pickerRow(picker, REMOTE_NAME), 'Remove remote project').click();
    await expect(pickerRow(picker, REMOTE_NAME)).toHaveCount(0);
    await expect(pickerRow(picker, P.acmeApi)).toBeVisible();
    expect(await projectPaths(page)).not.toContain(REMOTE_PATH);
  });

  test('hide worktree asks first, then hides it and redraws the list in place', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await answerDialogs(page, true);
    await rowButton(pickerRow(picker, WORKTREE_NAME), 'Hide worktree').click();
    await expect(pickerRow(picker, WORKTREE_NAME)).toHaveCount(0);
    await expect(pickerRow(picker, P.acmeApi)).toBeVisible();
    expect(await projectPaths(page)).not.toContain(home.projectPath(P.goneParser));
  });

  test('archive all asks first, archives every session and redraws the list in place', async ({ page, home }) => {
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    const before = launchedKeys(home);
    await answerDialogs(page, true);
    await rowButton(pickerRow(picker, P.webDashboard), 'Archive all sessions in this project').click();
    await expect.poll(() => page.evaluate(async (path) => {
      const project = (await window.api.getProjects(true)).find(p => p.projectPath === path);
      return project?.sessions.every(s => s.archived);
    }, home.projectPath(P.webDashboard))).toBe(true);
    await expect(picker).toBeVisible();
    await expect(pickerRowBox(picker, P.webDashboard).getByText('0 sessions', { exact: true })).toBeVisible();
    await expect(pickerRowBox(picker, P.acmeApi).getByText('6 sessions', { exact: true })).toBeVisible();
    expect(launchedKeys(home)).toEqual(before);
  });

  test('archive all stops at the first session it cannot stop', async ({ page, app, home }) => {
    await failStopSession(app, 'still running');
    await openPicker(page);
    const picker = dialog(page, 'New Session');
    await answerDialogs(page, true);
    const types = async () => (await dialogsShown(page)).map(shown => shown.type);
    await rowButton(pickerRow(picker, P.webDashboard), 'Archive all sessions in this project').click();
    await expect.poll(types).toEqual(['confirm', 'alert']);
    await settle(page);
    expect(await types()).toEqual(['confirm', 'alert']);
    const archived = await page.evaluate(async (path) => {
      const project = (await window.api.getProjects(true)).find(p => p.projectPath === path);
      return project?.sessions.filter(s => s.archived).length;
    }, home.projectPath(P.webDashboard));
    expect(archived).toBe(0);
  });
});

test.describe('add project', () => {
  test('switching tabs focuses the first field and hides the error', async ({ page }) => {
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await expect(add.getByPlaceholder('/path/to/project')).toBeFocused();
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add.getByText('Please enter a folder path.')).toBeVisible();

    await add.getByRole('button', { name: 'Remote (SSH)', exact: true }).click();
    await expect(add.getByPlaceholder('user')).toBeFocused();
    await expect(add.getByText('Please enter a folder path.')).toBeHidden();
    await expect(add.getByPlaceholder('/path/to/project')).toBeHidden();

    await add.getByRole('button', { name: 'Local folder', exact: true }).click();
    await expect(add.getByPlaceholder('/path/to/project')).toBeFocused();
    await expect(add.getByPlaceholder('host or IP')).toBeHidden();
  });

  test('Browse fills the path from the folder picker', async ({ page, app, home }) => {
    const target = home.projectPath('Development/picked');
    await setHostStub(app, 'browseFolder', target);
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByRole('button', { name: 'Browse', exact: true }).click();
    await expect(add.getByPlaceholder('/path/to/project')).toHaveValue(target);
  });

  test('a cancelled folder picker leaves the path alone', async ({ page }) => {
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByPlaceholder('/path/to/project').fill('/typed/by/hand');
    await add.getByRole('button', { name: 'Browse', exact: true }).click();
    await settle(page);
    await expect(add.getByPlaceholder('/path/to/project')).toHaveValue('/typed/by/hand');
  });

  test('Enter submits from the path field, and a server error shows inline', async ({ page, home }) => {
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByPlaceholder('/path/to/project').fill(home.projectPath('Development/does-not-exist'));
    await page.keyboard.press('Enter');
    await expect(add.getByText('Path does not exist', { exact: true })).toBeVisible();
    await expect(add).toBeVisible();
  });

  test('remote needs a user and a host', async ({ page }) => {
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByRole('button', { name: 'Remote (SSH)', exact: true }).click();
    await add.getByPlaceholder('user').fill('deploy');
    await page.keyboard.press('Enter');
    await expect(add.getByText('Please enter a username and host.')).toBeVisible();
  });

  test('remote shows a server error inline', async ({ page }) => {
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByRole('button', { name: 'Remote (SSH)', exact: true }).click();
    await add.getByPlaceholder('user').fill('joris');
    await add.getByPlaceholder('host or IP').fill('buildbox.local');
    await add.getByPlaceholder(/^working directory/).fill('~/apps/api');
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add.getByText('This remote is already added.')).toBeVisible();
    await expect(add).toBeVisible();
  });

  test('remote port defaults to 22, and a given one is kept', async ({ page }) => {
    const add = dialog(page, 'Add Project');
    const addRemote = async (host: string, port: string) => {
      await openAddProject(page);
      await add.getByRole('button', { name: 'Remote (SSH)', exact: true }).click();
      await add.getByPlaceholder('user').fill('deploy');
      await add.getByPlaceholder('host or IP').fill(host);
      if (port) await add.getByPlaceholder('22', { exact: true }).fill(port);
      await add.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(add).toHaveCount(0);
    };
    await addRemote('one.example.com', '');
    await addRemote('two.example.com', '2222');
    expect(await projectPaths(page)).toEqual(expect.arrayContaining(
      ['ssh://deploy@one.example.com', 'ssh://deploy@two.example.com:2222']));
  });

  test('Cancel closes without adding', async ({ page }) => {
    await openAddProject(page);
    const add = dialog(page, 'Add Project');
    await add.getByPlaceholder('/path/to/project').fill('/anything');
    await add.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(add).toHaveCount(0);
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

  /** Open the dialog, change it with `edit`, resume, and answer the argv claude got. */
  async function resumeWith(page: Page, home: FixtureHome, edit: (resume: Locator) => Promise<void>) {
    await openResumeWithConfig(page, LABEL.releaseNotes);
    const resume = dialog(page, /^Resume Session/);
    await edit(resume);
    await resume.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(resume).toHaveCount(0);
    return (await fakeClaude(home, S.releaseNotes).launched()).argv;
  }

  /** A permission option, by its name (the button's text starts with it). */
  function option(resume: Locator, label: string) {
    return resume.getByRole('button', { name: new RegExp('^' + label) });
  }

  test('the fields start from the effective settings, with no worktree field', async ({ page }) => {
    await openResumeWithConfig(page, LABEL.releaseNotes);
    const resume = dialog(page, /^Resume Session/);
    await expect(resume.getByRole('heading')).toHaveText(`Resume Session — ${LABEL.releaseNotes}`);
    await expect(resume.getByRole('checkbox')).toBeChecked();
    await expect(resume.getByPlaceholder('e.g. aws-vault exec profile --')).toHaveValue('env SB_E2E=1');
    await expect(resume.getByPlaceholder('/path/to/dir1, /path/to/dir2')).toHaveValue('/opt/a, /opt/b');
    await expect(resume.getByText(/worktree/i)).toHaveCount(0);
  });

  test('resuming as opened passes the settings on', async ({ page, home }) => {
    const argv = await resumeWith(page, home, async () => {});
    expect(argv).toEqual(expect.arrayContaining(['--resume', S.releaseNotes, '--permission-mode', 'plan',
      '--chrome', '--add-dir', '/opt/a', '--add-dir', '/opt/b']));
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  test('what the fields are changed to is what it resumes with', async ({ page, home }) => {
    const argv = await resumeWith(page, home, async (resume) => {
      // The checkbox itself is hidden behind its slider; the label is what takes the click.
      await resume.getByRole('checkbox').locator('..').click();
      await expect(resume.getByRole('checkbox')).not.toBeChecked();
      await resume.getByPlaceholder('/path/to/dir1, /path/to/dir2').fill('');
    });
    expect(argv).not.toContain('--chrome');
    expect(argv).not.toContain('--add-dir');
  });

  test('picking a mode replaces the one before it', async ({ page, home }) => {
    const argv = await resumeWith(page, home, async (resume) => {
      await option(resume, 'Auto').click();
      await option(resume, 'Accept Edits').click();
    });
    expect(argv.filter(arg => arg === '--permission-mode')).toHaveLength(1);
    expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
  });

  test('Default omits the flag', async ({ page, home }) => {
    const argv = await resumeWith(page, home, async (resume) => {
      await option(resume, 'Default').click();
    });
    expect(argv).not.toContain('--permission-mode');
  });

  test('Dangerous Skip replaces the mode', async ({ page, home }) => {
    const argv = await resumeWith(page, home, async (resume) => {
      await option(resume, 'Dangerous Skip').click();
    });
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--permission-mode');
  });

  test('Dangerous Skip toggles off again, and the mode it cleared stays cleared', async ({ page, home }) => {
    const argv = await resumeWith(page, home, async (resume) => {
      await option(resume, 'Dangerous Skip').click();
      await option(resume, 'Dangerous Skip').click();
    });
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--permission-mode');
  });

  test('picking a mode clears Dangerous Skip', async ({ page, home }) => {
    const argv = await resumeWith(page, home, async (resume) => {
      await option(resume, 'Dangerous Skip').click();
      await option(resume, 'Plan Mode').click();
    });
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
  });

  test('Cancel closes without resuming', async ({ page, home }) => {
    await openResumeWithConfig(page, LABEL.releaseNotes);
    const resume = dialog(page, /^Resume Session/);
    await resume.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(resume).toHaveCount(0);
    await settle(page);
    expect(fakeClaude(home, S.releaseNotes).launches()).toHaveLength(0);
  });
});
