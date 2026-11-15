/**
 * The modal dialogs, in the app: their screenshots, and adding a real folder
 * from the Projects modal and starting a session in it.
 *
 * What the dialogs decide on their own — the modal's ranking, rows, keys and
 * folder check, the add form's blank-field rules, the permission grid and the
 * argv a resume is made with — is unit tested (test/dialogs*.test.ts,
 * test/projects-modal.test.ts, test/project-folder-service.test.ts). Walking
 * each dialog against main's answers (the modal's filter, keys and ⋯ menu, the
 * add step's errors and Browse, adding a remote, resuming with a changed
 * configuration) is component tested (component/tests/dialogs.spec.ts). What
 * stays here needs the app: a folder on disk that main adds as a project, and
 * the real launch in it.
 */
import fs from 'node:fs';
import {test, expect, forEachAppearance, screenTest} from '../support/test';
import {dialog, expectScreen, rowButton, sessionRow, sidebar} from '../support/app';
import {launchedKeys, waitForNewLaunch} from '../support/fake-cli';
import {LABEL} from '../fixtures/standard';
import type {Page} from '@playwright/test';

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
    const row = sessionRow(page, label);
    await row.hover();
    await rowButton(row, 'Resume with config').click();
}

/** Take the focus off whatever has it, so a stray Enter cannot click a button. */
async function blur(page: Page) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

function projectPaths(page: Page) {
    return page.evaluate(async () => (await window.api.getProjects(true)).map((p) => p.projectPath));
}

/** The page of the project the add test makes. */
function newProjectPage(page: Page) {
    return page.getByRole('region', {name: 'Project Development/brand-new'});
}

/** The lit sidebar rows: the highlight is the row's `active` class. */
function litRows(page: Page) {
    return sidebar(page).locator('[data-session-id].active');
}

forEachAppearance(() => {
    screenTest('dialog screens', async ({page}) => {
        /* When */
        await openProjects(page);
        await expect(projectsModal(page).getByText('Development/acme-api', {exact: true})).toBeVisible();

        /* Then */
        await expectScreen(page, 'dialog-project-picker', {soft: true});

        /* When */
        await page.keyboard.press('Meta+Period');
        await expect(page.getByRole('menu')).toBeVisible();

        /* Then */
        await expectScreen(page, 'dialog-project-menu', {soft: true});

        /* When */
        await page.keyboard.press('Escape');
        await page.keyboard.press('Meta+Enter');
        await expect(dialog(page, /Add project$/)).toBeVisible();

        /* Then */
        await expectScreen(page, 'dialog-add-project-local', {soft: true});

        /* When */
        await dialog(page, /Add project$/)
            .getByRole('tab', {name: 'Remote (SSH)'})
            .click();
        await expect(dialog(page, /Add project$/).getByPlaceholder('host or IP')).toBeVisible();

        /* Then */
        await expectScreen(page, 'dialog-add-project-remote', {soft: true});

        /* When */
        await page.keyboard.press('Escape');
        await openResumeWithConfig(page, LABEL.releaseNotes);
        await expect(dialog(page, /^Resume Session/)).toBeVisible();

        /* Then */
        await expectScreen(page, 'dialog-resume-with-config', {soft: true});
    });
});

test.describe('adding a project', () => {
    test('⌘A, paste a folder path, ↵: the folder is added and its page opens, ready to start in', async ({
        page,
        home,
    }) => {
        /* Given */
        const target = home.projectPath('Development/brand-new');
        fs.mkdirSync(target, {recursive: true});
        await blur(page);
        await page.keyboard.press('Meta+a');
        const modal = projectsModal(page);

        /* When */
        await filter(page).fill(home.projectPath('Development/bran'));
        await page.keyboard.press('Tab');

        /* Then */
        // ⇥ completes the path, and the folder is checked as it stands.
        await expect(filter(page)).toHaveValue(target + '/');
        await expect(modal.getByText('Folder, not a git repository · not added yet', {exact: true})).toBeVisible();

        /* When */
        await page.keyboard.press('Enter');

        /* Then */
        await expect(modal).toHaveCount(0);
        await expect(newProjectPage(page).getByRole('heading', {level: 1})).toHaveText('Development/brand-new');
        await expect(litRows(page)).toHaveCount(0);
        expect(await projectPaths(page)).toContain(target);

        /* When */
        const before = launchedKeys(home);
        await newProjectPage(page)
            .getByRole('button', {name: /^New session/})
            .click();

        /* Then */
        const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
        expect(launch.cwd).toBe(target);
    });
});
