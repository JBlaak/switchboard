/**
 * The modal dialogs: the Projects modal (starting a session, a project's ⋯
 * menu, adding a local folder or a remote) and resuming a session with a
 * different configuration.
 *
 * What the dialogs decide on their own — the modal's ranking, rows, keys and
 * folder check, the add form's blank-field rules, the permission grid and the
 * argv a resume is made with — is unit tested (test/dialogs*.test.ts,
 * test/projects-modal.test.ts, test/project-folder-service.test.ts). These
 * walk each dialog through the renderer against main's answers (the projects,
 * the folders on disk and the settings kept by support/main-world.ts): the
 * keys and clicks reach it, and what it asks main for, a launch's options
 * among it, comes back. Adding a real folder and starting a session in it is
 * the e2e journey (e2e/tests/dialogs.spec.ts).
 */
import {test, expect, sessionRow as row} from '../support/main-world';
import {chooseProjectAction, dialog, rowButton, sessionRow, sidebar, terminalStatus} from '../../e2e/support/app';
import {answerDialogs, dialogsShown} from '../../e2e/support/native-dialogs';
import {LABEL, P, S} from '../../e2e/fixtures/standard';
import {fixtureProjectPath} from '../fixtures/captured';
import type {Project} from '../../src/domain/project/project';
import type {Locator, Page} from '@playwright/test';

function openProjects(page: Page) {
    return page.getByRole('button', {name: 'Projects', exact: true}).click();
}

function projectsModal(page: Page) {
    return dialog(page, 'Projects');
}

function filter(page: Page) {
    return projectsModal(page).getByLabel('Filter projects');
}

async function openResumeWithConfig(page: Page, label: string) {
    const session = sessionRow(page, label);
    await session.hover();
    await rowButton(session, 'Resume with config').click();
}

/** Take the focus off whatever has it, so a stray Enter cannot click a button. */
async function blur(page: Page) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** A modal row's name; `rowButton` climbs from it to the highlighted row's buttons. */
function pickerRow(modal: Locator, name: string | RegExp) {
    return modal.getByText(name, {exact: true});
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

const REMOTE_PATH = 'ssh://joris@buildbox.local/~/apps/api';
/** The remote's name is followed by its "SSH" badge, inside the same element. */
const REMOTE_NAME = /^joris@buildbox\.local\/api/;
const WORKTREE_NAME = 'Development/old-parser ⎇ streaming';
const BRAND_NEW = fixtureProjectPath('Development/brand-new');

/** The page of the project the add tests make. */
function newProjectPage(page: Page) {
    return page.getByRole('region', {name: 'Project Development/brand-new'});
}

/** The lit sidebar rows: the highlight is the row's `active` class. */
function litRows(page: Page) {
    return sidebar(page).locator('[data-session-id].active');
}

test.describe('projects modal', () => {
    test.use({
        settings: {
            [`project:${fixtureProjectPath(P.webDashboard)}`]: {
                permissionMode: 'plan',
                chrome: true,
                addDirs: '/opt/shared',
            },
        },
    });

    test('filters as you type, closes on Escape or the backdrop, and launches from the keys or the pointer', async ({
        page,
        world,
    }) => {
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
        await page.getByRole('heading', {name: 'Projects'}).click();

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
        await page.keyboard.press('Enter');

        /* Then */
        await expect(modal).toHaveCount(0);
        await expect
            .poll(() => world.launches().map((launch) => launch.projectPath))
            .toEqual([fixtureProjectPath(P.notes)]);
        expect(world.launches()[0].isNew).toBe(true);

        /* When */
        await openProjects(page);
        await pickerRow(modal, P.webDashboard).hover();
        await page.keyboard.press('Enter');

        /* Then */
        await expect(modal).toHaveCount(0);
        await expect.poll(() => world.launches()).toHaveLength(2);
        const dashboard = world.launches()[1];
        expect(dashboard.projectPath).toBe(fixtureProjectPath(P.webDashboard));
        // The project's settings, which main turns into `--permission-mode plan --chrome --add-dir /opt/shared`.
        expect(dashboard.options).toMatchObject({permissionMode: 'plan', chrome: true, addDirs: '/opt/shared'});

        /* When */
        await openProjects(page);

        /* Then */
        await expect(pickerRowBox(modal, P.notes).getByText('1 running', {exact: true})).toBeVisible();
        await expect(pickerRowBox(modal, P.webDashboard).getByText('1 running', {exact: true})).toBeVisible();
        // Archived sessions are not counted.
        await expect(pickerRowBox(modal, P.acmeApi).getByText('6 sessions', {exact: true})).toBeVisible();
    });

    test('the ⋯ menu asks first, changes the projects in place, and never launches', async ({page, world}) => {
        /* Given */
        await openProjects(page);
        const modal = projectsModal(page);
        await expect(pickerRow(modal, REMOTE_NAME)).toBeVisible();

        /* When */
        // Only the highlighted row has buttons: the old per-row icons are gone.
        await pickerRow(modal, P.acmeApi).hover();
        await page.keyboard.press('Meta+Period');

        /* Then */
        await expect(modal.getByRole('button', {name: /^More for /})).toHaveCount(1);
        await expect(page.getByRole('menuitem')).toHaveText([
            'Project settings',
            'Open on GitHub',
            /^Archive all \d+ sessions?…$/,
            'Hide project',
        ]);

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
        expect(world.projectPaths()).toContain(REMOTE_PATH);

        /* When */
        await answerDialogs(page, true);
        await chooseProjectAction(page, REMOTE_NAME, 'Remove project');

        /* Then */
        await expect(pickerRow(modal, REMOTE_NAME)).toHaveCount(0);
        await expect(pickerRow(modal, P.acmeApi)).toBeVisible();
        expect(world.projectPaths()).not.toContain(REMOTE_PATH);

        /* When */
        await answerDialogs(page, true);
        await chooseProjectAction(page, WORKTREE_NAME, 'Hide project');

        /* Then */
        await expect(pickerRow(modal, WORKTREE_NAME)).toHaveCount(0);
        expect(world.projectPaths()).not.toContain(fixtureProjectPath(P.goneParser));

        /* When */
        await answerDialogs(page, true);
        await chooseProjectAction(page, P.webDashboard, /^Archive all /);

        /* Then */
        await expect
            .poll(() => world.project(fixtureProjectPath(P.webDashboard))?.sessions.every((s) => s.archived))
            .toBe(true);
        await expect(modal).toBeVisible();
        await expect(pickerRowBox(modal, P.webDashboard).getByText('0 sessions', {exact: true})).toBeVisible();
        await expect(pickerRowBox(modal, P.acmeApi).getByText('6 sessions', {exact: true})).toBeVisible();

        /* When */
        world.stopResult = {ok: false, error: 'still running'};
        const archived = () => world.project(fixtureProjectPath(P.acmeApi))?.sessions.filter((s) => s.archived).length;
        const archivedBefore = archived();
        await answerDialogs(page, true);
        const prompts = async () => (await dialogsShown(page)).map((shown) => shown.type);
        await chooseProjectAction(page, P.acmeApi, /^Archive all /);

        /* Then */
        // Archive all stops at the first session it cannot stop, and says so once.
        await expect.poll(prompts).toEqual(['confirm', 'alert']);
        await settle(page);
        expect(await prompts()).toEqual(['confirm', 'alert']);
        expect(archived()).toBe(archivedBefore);

        /* When */
        await chooseProjectAction(page, P.acmeApi, 'Project settings');

        /* Then */
        await expect(modal).toHaveCount(0);
        // The project's settings, on its page (#176).
        await expect(page.getByRole('region', {name: `Settings for ${P.acmeApi}`})).toBeVisible();
        await settle(page);
        expect(world.launches()).toEqual([]);
    });
});

test.describe('projects modal order', () => {
    /** A local project with one session, `at` its last change. */
    function project(relative: string, id: string, prompt: string, at: string, archived = 0): Project {
        const projectPath = fixtureProjectPath(relative);
        return {
            projectPath,
            folder: projectPath.replace(/[^a-zA-Z0-9]/g, '-'),
            sessions: [
                row({
                    sessionId: id,
                    projectPath,
                    summary: prompt,
                    firstPrompt: prompt,
                    created: at,
                    modified: at,
                    archived,
                }),
            ],
        };
    }

    const projects = [
        project('Development/older', 'older-0000', 'Tidy the README', '2026-06-07T14:00:00.000Z'),
        project('Development/archived-today', 'archived-0000', 'Ship the fix', '2026-06-10T13:00:00.000Z', 1),
        project('Development/untouched', 'untouched-0000', 'Set it up', '2026-05-11T14:00:00.000Z'),
    ];
    test.use({
        fixture: {
            projects: projects.map((p) => ({...p, sessions: p.sessions.filter((s) => !s.archived)})),
            projectsWithArchived: projects,
        },
    });

    /** The modal's project names, top to bottom. */
    function order(page: Page) {
        return projectsModal(page).locator('.project-picker-name').filter({hasNotText: 'Add project…'});
    }

    test('lists projects by their most recent session, archived ones too, and reorders once a session starts', async ({
        page,
        world,
    }) => {
        /* Given */
        await openProjects(page);

        /* Then */
        await expect(order(page)).toHaveText([
            'Development/archived-today',
            'Development/older',
            'Development/untouched',
        ]);

        /* When */
        await page.keyboard.type('untouched');
        await page.keyboard.press('Enter');
        await expect.poll(() => world.launches()).toHaveLength(1);
        await openProjects(page);

        /* Then */
        await expect(order(page)).toHaveText([
            'Development/untouched',
            'Development/archived-today',
            'Development/older',
        ]);
    });
});

test.describe('adding a project', () => {
    test('the add step: back with the search kept, a blank path, a missing one, Browse, then Add', async ({
        page,
        api,
        world,
    }) => {
        /* Given */
        world.folders.add(BRAND_NEW);
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
        await add.getByRole('button', {name: 'Add', exact: true}).click();

        /* Then */
        await expect(add.getByText('Please enter a folder path.')).toBeVisible();

        /* When */
        await add.getByRole('tab', {name: 'Remote (SSH)'}).click();

        /* Then */
        // Each tab's first field takes the focus, and a switch hides the error.
        await expect(add.getByPlaceholder('user')).toBeFocused();
        await expect(add.getByText('Please enter a folder path.')).toBeHidden();
        await expect(path).toBeHidden();

        /* When */
        await add.getByRole('tab', {name: 'Local folder'}).click();
        await path.fill(fixtureProjectPath('Development/does-not-exist'));

        /* Then */
        await expect(add.getByText('No folder at this path', {exact: true})).toBeVisible();

        /* When */
        await page.keyboard.press('Enter');

        /* Then */
        await expect(add.getByText('Path does not exist', {exact: true})).toBeVisible();

        /* When */
        // The folder picker answers nothing, as a cancelled picker does.
        api.answer('browseFolder', null);
        await path.fill('/typed/by/hand');
        await add.getByRole('button', {name: 'Browse…', exact: true}).click();

        /* Then */
        await expect.poll(() => api.callsTo('browseFolder')).toHaveLength(1);
        await settle(page);
        await expect(path).toHaveValue('/typed/by/hand');

        /* When */
        api.answer('browseFolder', BRAND_NEW);
        await add.getByRole('button', {name: 'Browse…', exact: true}).click();

        /* Then */
        await expect(path).toHaveValue(BRAND_NEW);
        await expect(add.getByText('Folder exists', {exact: true})).toBeVisible();
        await expect(add.getByText('Not a git repository', {exact: true})).toBeVisible();

        /* When */
        await add.getByRole('button', {name: 'Add', exact: true}).click();

        /* Then */
        // The modal gives way to the new project's page.
        await expect(projectsModal(page)).toHaveCount(0);
        await expect(newProjectPage(page)).toBeVisible();
        await expect(litRows(page)).toHaveCount(0);
        expect(api.callsTo('addProject')).toEqual([[fixtureProjectPath('Development/does-not-exist')], [BRAND_NEW]]);
    });

    test('the Add project button beside the title opens the add step, and a folder added there opens its page', async ({
        page,
        world,
    }) => {
        /* Given */
        world.folders.add(BRAND_NEW);
        await openProjects(page);
        const add = dialog(page, /Add project$/);

        /* When */
        await projectsModal(page).getByRole('button', {name: 'Add project', exact: true}).click();

        /* Then */
        await expect(add.getByPlaceholder('/path/to/project')).toBeFocused();
        await expect(add.getByRole('button', {name: 'Add project', exact: true})).toHaveCount(0);

        /* When */
        await add.getByPlaceholder('/path/to/project').fill(BRAND_NEW);
        await add.getByRole('button', {name: 'Add', exact: true}).click();

        /* Then */
        await expect(projectsModal(page)).toHaveCount(0);
        await expect(newProjectPage(page)).toBeVisible();
    });

    test('user@host opens the SSH tab filled in; a duplicate is refused, a new one added, its page opened and dialled from it', async ({
        page,
        world,
    }) => {
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
        await expect(add.getByRole('tab', {name: 'Remote (SSH)'})).toHaveAttribute('aria-selected', 'true');
        await expect(add.getByPlaceholder('user')).toHaveValue('joris');
        await expect(add.getByPlaceholder('host or IP')).toHaveValue('buildbox.local');

        /* When */
        await add.getByPlaceholder(/^working directory/).fill('~/apps/api');
        await add.getByRole('button', {name: 'Add', exact: true}).click();

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
        await add.getByPlaceholder('22', {exact: true}).fill('2222');
        await add.getByPlaceholder(/^working directory/).fill('');
        await page.keyboard.press('Enter');

        /* Then */
        await expect(modal).toHaveCount(0);
        expect(world.projectPaths()).toContain('ssh://deploy@staging.example.com:2222');
        const remotePage = page.getByRole('region', {name: /^Project deploy@staging\.example\.com/});
        await expect(remotePage).toBeVisible();

        /* When */
        await remotePage.getByRole('button', {name: /^New session/}).click();

        /* Then */
        await expect.poll(() => world.launches()).toHaveLength(1);
        expect(world.launches()[0]).toMatchObject({
            projectPath: 'ssh://deploy@staging.example.com:2222',
            isNew: true,
            options: {type: 'remote'},
        });
    });
});

test.describe('resume with config', () => {
    test.use({
        settings: {
            [`project:${fixtureProjectPath(P.acmeApi)}`]: {
                permissionMode: 'plan',
                chrome: true,
                preLaunchCmd: 'env SB_E2E=1',
                addDirs: '/opt/a, /opt/b',
            },
        },
    });

    /** A permission option, by its name (the button's text starts with it). */
    function option(resume: Locator, label: string) {
        return resume.getByRole('button', {name: new RegExp('^' + label)});
    }

    test('opens on the effective settings, closes without resuming, and resumes with what was changed', async ({
        page,
        world,
    }) => {
        /* Given */
        const resume = dialog(page, /^Resume Session/);

        /* When */
        await openResumeWithConfig(page, LABEL.releaseNotes);

        /* Then */
        await expect(resume.getByRole('heading')).toHaveText(`Resume Session — ${LABEL.releaseNotes}`);
        await expect(resume.getByRole('checkbox')).toBeChecked();
        await expect(resume.getByPlaceholder('e.g. aws-vault exec profile --')).toHaveValue('env SB_E2E=1');
        await expect(resume.getByPlaceholder('/path/to/dir1, /path/to/dir2')).toHaveValue('/opt/a, /opt/b');
        await expect(resume.getByText(/worktree/i)).toHaveCount(0);

        /* When */
        await resume.getByRole('button', {name: 'Cancel', exact: true}).click();

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
        expect(world.launches()).toHaveLength(0);

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
        await expect.poll(() => world.launches()).toHaveLength(1);
        // What main turns into `--resume <id> --permission-mode acceptEdits`, without --chrome or --add-dir.
        const {sessionId, isNew, options} = world.launches()[0];
        expect(sessionId).toBe(S.releaseNotes);
        expect(isNew).toBe(false);
        expect(options.permissionMode).toBe('acceptEdits');
        expect(options.chrome).toBeFalsy();
        expect(options.addDirs ?? '').toBe('');
    });
});
