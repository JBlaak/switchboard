/**
 * The modal dialogs, in the app: adding a real folder from
 * the Projects modal and starting a session in it.
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
import {test, expect} from '../support/test';
import {dialog, sidebar} from '../support/app';
import {launchedKeys, waitForNewLaunch} from '../support/fake-cli';
import type {Page} from '@playwright/test';

function projectsModal(page: Page) {
    return dialog(page, 'Projects');
}

function filter(page: Page) {
    return projectsModal(page).getByLabel('Filter projects');
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
