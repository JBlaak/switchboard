/**
 * The Issue manager page (#415): ⌘I opens it on the inbox main holds, J
 * selects an issue and reads its thread, your notes are kept by main, and ⏎
 * starts a session on it that the page then lists under In progress. Close
 * on GitHub closes it there, with a comment if you wrote one. The detail
 * closes with its × or Esc.
 *
 * The rules (prompt, footer, labels, stages, keys) are unit tested in
 * test/inbox-issue-manager.test.ts, test/issue-manager-*.test.ts and
 * test/plan-start.test.ts. Main's inbox is played by component/support/inbox.ts,
 * and Start's worktree and prompt are answered as main makes them for this
 * issue (test/issue-session-service.test.ts makes them for real).
 */
import {test, expect} from '../support/inbox';
import {runSessions} from '../support/running-session';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {NO_INBOX_FRESHNESS} from '../../src/domain/inbox/freshness';
import {finish} from '../../src/domain/inbox/items';
import {P} from '../../e2e/fixtures/standard';
import {fixtureProjectPath} from '../fixtures/captured';
import type {InboxItem} from '../../src/domain/inbox/model';
import type {IssueThread} from '../../src/domain/inbox/issue-manager';
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

const THREAD: IssueThread = {
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
};

const PROJECT = fixtureProjectPath(P.acmeApi);
const WORKTREE = PROJECT + '/.claude/worktrees/482-issue';
const PROMPT = 'Work on #482, a loose issue in no plan.';

test.use({
    inbox: {items: [ISSUE]},
    answers: {
        issueManagerThread: (key) => (key === KEY ? THREAD : null),
        // Claimed, and its worktree made, as main does for a loose issue.
        issueManagerPrepareStart: (key) =>
            key === KEY
                ? {ok: true, projectPath: PROJECT, worktreePath: WORKTREE, branch: '482-issue', prompt: PROMPT}
                : {ok: false, reason: 'That issue is no longer in the Issue manager'},
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
    api,
    mainInbox,
}) => {
    /* Given */
    runSessions(api);

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
    expect(mainInbox.item(KEY)?.notes).toBe('It is the CSV export.');

    /* When */
    await managerPage(page).focus();
    await page.keyboard.press('Enter');

    /* Then: a session in the issue's worktree, and the issue under In progress */
    await expect.poll(() => api.callsTo('openTerminal')).toHaveLength(1);
    const [, cwd, isNew, options] = api.callsTo('openTerminal')[0]!;
    expect(cwd).toBe(WORKTREE);
    expect(isNew).toBe(true);
    expect(options?.initialPrompt).toBe(PROMPT);
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

test('Close on GitHub closes the issue with the comment you wrote, and lists it under Done', async ({
    page,
    api,
    mainInbox,
}) => {
    /* Given: main closes it on GitHub and puts it under Done */
    api.handle('issueManagerClose', async (key) => ({
        ok: true as const,
        item: await mainInbox.change(key, (item) => finish(item, FIXTURE_NOW)),
    }));
    await page.keyboard.press('Meta+i');
    await expect(managerPage(page).getByRole('option', {name: /#482/})).toBeVisible();
    await page.keyboard.press('j');

    /* When */
    await detail(page).getByRole('button', {name: 'Close on GitHub'}).click();

    /* Then: asked first, with the comment empty and focused */
    const ask = detail(page).getByRole('group', {name: 'Close on GitHub'});
    await expect(ask).toContainText('Close #482 on GitHub?');
    await expect(ask.getByRole('textbox', {name: 'Closing comment'})).toBeFocused();
    await expect(ask.getByRole('button', {name: 'Close issue'})).toBeVisible();

    /* When */
    await page.keyboard.type('Fixed in 2.4.');
    await ask.getByRole('button', {name: 'Comment and close'}).click();

    /* Then */
    expect(api.callsTo('issueManagerClose')).toEqual([[KEY, 'Fixed in 2.4.']]);
    await expect(managerPage(page).getByRole('status')).toHaveText(
        'Closed #482 on GitHub with your comment; it is under Done.',
    );
    await expect(managerPage(page)).toContainText('Inbox zero.');
    await managerPage(page).getByRole('tab', {name: /Done/}).click();
    await expect(managerPage(page).getByRole('option', {name: /#482/})).toBeVisible();
});

test('Close on GitHub that GitHub refuses keeps the box open with why, and Esc puts it away', async ({page, api}) => {
    /* Given */
    api.handle('issueManagerClose', () => ({ok: false as const, reason: 'HTTP 403: Resource not accessible'}));
    await page.keyboard.press('Meta+i');
    await expect(managerPage(page).getByRole('option', {name: /#482/})).toBeVisible();
    await page.keyboard.press('j');
    await detail(page).getByRole('button', {name: 'Close on GitHub'}).click();
    const ask = detail(page).getByRole('group', {name: 'Close on GitHub'});

    /* When */
    await ask.getByRole('button', {name: 'Close issue'}).click();

    /* Then */
    await expect(ask.getByRole('alert')).toHaveText('HTTP 403: Resource not accessible');
    await expect(managerPage(page).getByRole('option', {name: /#482/})).toBeVisible();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(ask).toHaveCount(0);
    await expect(detail(page)).toBeVisible();
});

test('The issue detail closes with its × or Esc, and Esc then closes the page', async ({page}) => {
    /* Given */
    await page.keyboard.press('Meta+i');
    // J before the items are in selects nothing.
    await expect(managerPage(page).getByRole('option', {name: /#482/})).toBeVisible();
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

test('the header says when GitHub was last read, and spins while it is read again', async ({page, api, mainInbox}) => {
    /* Given */
    const read = {fetchedAt: FIXTURE_NOW - 5 * 60_000, refreshing: false, failed: false};
    await page.keyboard.press('Meta+i');

    /* When */
    await api.emit('onInboxChanged', {...mainInbox.summary(), freshness: {...NO_INBOX_FRESHNESS, issue: read}});

    /* Then */
    await expect(managerPage(page).getByTestId('freshness')).toHaveText('Updated 5m ago');

    /* When */
    await api.emit('onInboxChanged', {
        ...mainInbox.summary(),
        freshness: {...NO_INBOX_FRESHNESS, issue: {...read, refreshing: true}},
    });

    /* Then */
    const freshness = managerPage(page).getByTestId('freshness');
    await expect(freshness.getByRole('status', {name: 'Updating…'})).toBeVisible();
    await expect(freshness).toHaveText('Updated 5m ago');
});
