/**
 * The modal dialogs: the project picker, adding a project (local and remote)
 * and resuming a session with a different configuration.
 */
import fs from 'node:fs';
import { test, expect, forEachAppearance } from '../support/test';
import { dialog, expectScreen, rowButton, sessionRow, terminalStatus } from '../support/app';
import { fakeClaude } from '../support/fake-cli';
import { LABEL, S } from '../fixtures/standard';
import type { Page } from '@playwright/test';

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
