/**
 * The Issue manager page (#415) wired into the real app: ⌘I opens it on the
 * inbox main found at launch, J selects an issue and reads its thread, your
 * notes are kept by main, and ⏎ starts a session on it that the page then
 * lists under In progress. The detail closes with its × or Esc.
 *
 * The rules (prompt, footer, labels, stages, keys) are unit tested in
 * test/inbox-issue-manager.test.ts, test/issue-manager-*.test.ts and
 * test/plan-start.test.ts; GitHub and git are stubbed here, the inbox and
 * the session start are real.
 */
import fs from 'node:fs';
import {test, expect} from '../support/test';
import {FakeCli} from '../support/fake-cli';
import {FIXTURE_NOW} from '../support/fixture-home';
import {P, standardFixture} from '../fixtures/standard';
import type {InboxItem} from '../../src/domain/inbox/model';
import type {Page} from '@playwright/test';

const KEY = 'issue:acme/api#482';

const ISSUE: InboxItem = {
    key: KEY,
    manager: 'issue',
    source: 'acme/api',
    createdAt: FIXTURE_NOW,
    state: {kind: 'unread'},
    signals: null,
    notes: '',
    facts: {
        kind: 'issue',
        repository: 'acme/api',
        number: 482,
        title: 'Export on the coach page',
        url: 'https://github.com/acme/api/issues/482',
        author: 'pieter',
        assignees: [],
        labels: ['coach', 'export', 'web'].map((name) => ({name, color: 'ededed'})),
        createdAt: new Date(FIXTURE_NOW - 2 * 3_600_000).toISOString(),
        updatedAt: new Date(FIXTURE_NOW - 3_600_000).toISOString(),
        comments: 2,
        lastCommentBy: 'marieke',
        references: 0,
    },
};

test.use({
    fixture: {...standardFixture(), inboxItems: [ISSUE]},
    stubs: {
        issueManager: {
            project: P.acmeApi,
            threads: {
                [KEY]: {
                    body: 'The export button does nothing.',
                    comments: [
                        {
                            author: 'marieke',
                            body: "It's the athletes list, top right.",
                            createdAt: new Date(FIXTURE_NOW - 3_600_000).toISOString(),
                        },
                    ],
                    total: 2,
                    viewer: 'joris',
                },
            },
        },
    },
});

function managerPage(page: Page) {
    return page.getByRole('region', {name: 'Issue manager'});
}

function detail(page: Page) {
    return page.getByRole('complementary', {name: 'Issue detail'});
}

test('⌘I opens the Issue manager on its issues, keeps your notes, and ⏎ starts and claims one', async ({
    page,
    home,
}) => {
    /* When */
    await page.keyboard.press('Meta+i');

    /* Then */
    await expect(managerPage(page).getByRole('heading', {name: 'Issue manager'})).toBeVisible();
    const row = managerPage(page).getByRole('option', {name: /#482 Export on the coach page/});
    await expect(row).toContainText('coach');
    await expect(row).toContainText('export');
    await expect(row).toContainText('+1');
    await expect(row).toContainText('pieter');
    await expect(row).toContainText('unassigned');
    await expect(row).toContainText('New');

    /* When */
    await page.keyboard.press('j');

    /* Then */
    await expect(detail(page).getByRole('heading', {name: 'Export on the coach page'})).toBeVisible();
    await expect(detail(page).getByRole('button', {name: 'Open in GitHub ↗'})).toBeVisible();
    await expect(detail(page)).toContainText("It's the athletes list, top right.");

    /* When: notes typed, then the page closed and opened again */
    await page.keyboard.press('c');
    await page.keyboard.type('It is the CSV export.');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+i');
    await expect(managerPage(page)).toHaveCount(0);
    await page.keyboard.press('Meta+i');
    await page.keyboard.press('j');

    /* Then: main kept them */
    await expect(detail(page).getByRole('textbox', {name: 'Your notes'})).toHaveValue('It is the CSV export.');

    /* When */
    fs.mkdirSync(home.projectPath(P.acmeApi + '/.claude/worktrees/482-issue'), {recursive: true});
    const before = fs.readdirSync(home.controlDir);
    await managerPage(page).focus();
    await page.keyboard.press('Enter');

    /* Then: a session in the issue's worktree, and the issue under In progress */
    const startedSince = () => fs.readdirSync(home.controlDir).filter((key) => !before.includes(key));
    await expect.poll(startedSince).toHaveLength(1);
    const launch = await new FakeCli(home.controlDir, startedSince()[0]!).launched();
    expect(launch.cwd).toMatch(/\/\.claude\/worktrees\/482-issue$/);
    expect(launch.argv[launch.argv.length - 1]).toBe('Work on #482, a loose issue in no plan.');
    await expect(managerPage(page)).toContainText('Inbox zero.');
    await expect(managerPage(page).getByRole('status')).toHaveText(
        'Started a session on #482; it is under In progress.',
    );

    /* When */
    await managerPage(page)
        .getByRole('tab', {name: /In progress/})
        .click();

    /* Then */
    await expect(managerPage(page).getByRole('option', {name: /#482/})).toContainText('Working');
});

test("a row's Backlog button puts the issue in the backlog at once, without selecting it", async ({page}) => {
    /* Given */
    await page.keyboard.press('Meta+i');
    const row = managerPage(page).getByRole('option', {name: /#482 Export on the coach page/});
    await expect(row).toBeVisible();

    /* When */
    await row.hover();
    await row.getByRole('button', {name: 'Put #482 in the backlog'}).click();

    /* Then: gone from the inbox, unselected, and listed under Backlog with no reload */
    await expect(managerPage(page)).toContainText('Inbox zero.');
    await expect(detail(page)).toHaveCount(0);
    await managerPage(page)
        .getByRole('tab', {name: /Backlog/})
        .click();
    const backlogged = managerPage(page).getByRole('option', {name: /#482/});
    await expect(backlogged).toBeVisible();
    await expect(backlogged.getByRole('button', {name: 'Put #482 in the backlog'})).toHaveCount(0);
});

test('The issue detail closes with its × or Esc, and Esc then closes the page', async ({page}) => {
    /* Given */
    await page.keyboard.press('Meta+i');
    await page.keyboard.press('j');
    await expect(detail(page)).toBeVisible();

    /* When */
    await detail(page).getByRole('button', {name: 'Close the issue (Esc)'}).click();

    /* Then */
    await expect(detail(page)).toHaveCount(0);
    await expect(managerPage(page)).toBeVisible();

    /* When */
    await page.keyboard.press('j');
    await expect(detail(page)).toBeVisible();
    await page.keyboard.press('Escape');

    /* Then */
    await expect(detail(page)).toHaveCount(0);
    await expect(managerPage(page)).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(managerPage(page)).toHaveCount(0);
});
