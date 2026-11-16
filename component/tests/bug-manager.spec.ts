/**
 * The Bug manager page (#414): ⌘B opens it on the inbox main holds, grouped
 * by local project with "Not linked" last, a filter narrows it, J moves the
 * cursor and marks the row seen, and F starts Claude in the Fix's worktree of
 * the linked project with the Fix prompt, which moves the bug to In progress.
 *
 * The tabs, filters, groups, keys and stages are unit tested in
 * test/bug-page-slice.test.ts, and the Fix's worktree, branch and prompt in
 * test/bug-fix-service.test.ts; this proves the page, the keyboard and the
 * session start against what main answers. Main's inbox is played by
 * component/support/inbox.ts; Settings → Bug manager's links are the stored
 * settings the page reads, and no Bugsnag token is saved, so the detail's
 * reads answer nothing.
 */
import {test, expect} from '../support/inbox';
import {runSessions} from '../support/running-session';
import {FIXTURE_NOW, HARNESS_SETTINGS} from '../../e2e/support/fixture-home';
import {NO_INBOX_FRESHNESS} from '../../src/domain/inbox/freshness';
import {P} from '../../e2e/fixtures/standard';
import {fixtureProjectPath} from '../fixtures/captured';
import {fixBranch, fixPrompt} from '../../src/domain/inbox/fix';
import {markRegressed, startWork, updateFix} from '../../src/domain/inbox/items';
import type {Page} from '@playwright/test';
import type {BugFacts, InboxItem} from '../../src/domain/inbox/model';

const API = '6a0000000000000000000001';
const ANDROID = '6a0000000000000000000002';
const TRENDING = '5f2a91c0deadbeef00000001';
const QUIET = '5f2a91c0deadbeef00000002';
const UNLINKED = '7b11aa00deadbeef00000003';
const SEEN_AGAIN = '5f2a91c0deadbeef00000004';

const PROJECT = fixtureProjectPath(P.acmeApi);

function bugItem(projectId: string, errorId: string, facts: Partial<BugFacts>, trending = false): InboxItem {
    return {
        key: `bug:${projectId}:${errorId}`,
        manager: 'bug',
        source: projectId,
        createdAt: Date.parse('2026-11-01T09:00:00Z'),
        state: {kind: 'unread'},
        facts: {
            kind: 'bug',
            projectId,
            errorId,
            errorClass: 'TypeError',
            message: 'Something broke',
            context: 'GET /api/workouts',
            severity: 'error',
            status: 'open',
            releaseStages: ['production'],
            firstSeen: '2026-10-01T09:00:00Z',
            lastSeen: '2026-11-12T09:00:00Z',
            events: 120,
            users: 14,
            events24h: 2,
            events7d: 14,
            linkedIssues: [],
            ...facts,
        },
        signals: {new: false, trending, regressed: false},
        notes: '',
        work: null,
        fix: null,
    };
}

/** A bug fixed by a merged PR whose events after the merge came from an older release. */
function seenAgainItem(): InboxItem {
    const merged = Date.parse('2026-11-10T10:00:00Z');
    return {
        ...bugItem(API, SEEN_AGAIN, {
            errorClass: 'TypeError',
            message: "Cannot read properties of undefined (reading 'split')",
        }),
        state: {kind: 'done', at: merged},
        work: {branch: 'fix/bugsnag-5f2a91c0', sessionId: null, pullRequest: 812},
        fix: {
            projectPath: '/fixture/acme-api',
            repository: 'acme/api',
            branch: 'fix/bugsnag-5f2a91c0',
            worktree: '/fixture/acme-api/.claude/worktrees/fix/bugsnag-5f2a91c0',
            sessionId: null,
            startedAt: merged - 3_600_000,
            pr: {number: 812, url: 'https://github.com/acme/api/pull/812'},
            queuePosition: null,
            checks: null,
            sessionEnded: true,
            ended: null,
            mergedAt: merged,
            mergeCommit: 'abc1234',
            markedFixed: true,
            quietSince: merged,
            seenAgain: {events: 3, version: '4.12.0', tag: 'v4.12.1', tagged: true},
            timeline: [],
        },
    };
}

const TRENDING_BUG = bugItem(
    API,
    TRENDING,
    {
        errorClass: 'ErrorException',
        message: 'Undefined array key "workout_id"',
        lastSeen: '2026-11-12T11:00:00Z',
    },
    true,
);

test.use({
    inbox: {
        items: [
            TRENDING_BUG,
            bugItem(API, QUIET, {errorClass: 'QueryException', message: 'Deadlock found'}),
            bugItem(ANDROID, UNLINKED, {errorClass: 'IllegalStateException', message: 'Fragment not attached'}),
            seenAgainItem(),
        ],
    },
    // Settings → Bug manager as a user leaves it: Connect API linked to acme-api, Coach Android to nothing.
    settings: {
        global: {
            ...(HARNESS_SETTINGS.global as Record<string, unknown> | undefined),
            bugsnag: {
                projects: [
                    {id: API, name: 'Connect API', optedIn: true, localProject: PROJECT},
                    {id: ANDROID, name: 'Coach Android', optedIn: true, localProject: null},
                ],
                trending: {multiplier: 3, minEvents: 20},
            },
        },
    },
});

function bugPage(page: Page) {
    return page.getByRole('region', {name: 'Bug manager'});
}

function row(page: Page, errorId: string, projectId = API) {
    return bugPage(page).locator(`[data-bug-key="bug:${projectId}:${errorId}"]`);
}

test('⌘B opens the Bug manager on its inbox; a filter narrows it and J marks the next row seen', async ({page}) => {
    /* When */
    await page.keyboard.press('Meta+b');

    /* Then */
    await expect(bugPage(page)).toBeFocused();
    await expect(bugPage(page).getByRole('heading', {level: 1})).toHaveText('Bug manager');
    const groups = bugPage(page).getByRole('heading', {level: 2});
    await expect(groups.nth(0)).toContainText('acme-api');
    await expect(groups.nth(0)).toContainText('from Connect API');
    await expect(groups.nth(1)).toContainText('Not linked');
    await expect(row(page, TRENDING)).toHaveAttribute('aria-selected', 'true');
    await expect(bugPage(page).getByRole('tab', {name: /^Inbox/})).toContainText('3');

    /* When */
    await bugPage(page)
        .getByRole('button', {name: /Trending/})
        .click();

    /* Then */
    await expect(row(page, QUIET)).toBeHidden();
    await expect(row(page, TRENDING)).toBeVisible();

    /* When */
    await bugPage(page)
        .getByRole('button', {name: /Trending/})
        .click();
    await bugPage(page).focus();
    await page.keyboard.press('j');

    /* Then */
    await expect(row(page, QUIET)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, QUIET)).not.toHaveClass(/is-unread/);

    /* When */
    await page.keyboard.press('Meta+b');

    /* Then */
    await expect(bugPage(page)).toBeHidden();
});

test('F fixes the bug under the cursor in a worktree of the linked project, and it moves to In progress', async ({
    page,
    api,
    mainInbox,
}) => {
    /* Given */
    runSessions(api);
    // What main's Fix makes for the linked project: the worktree on the bug's branch, and the prompt.
    const branch = fixBranch(TRENDING);
    const worktreePath = `${PROJECT}/.claude/worktrees/${branch}`;
    const prompt = fixPrompt({
        facts: TRENDING_BUG.facts as BugFacts,
        projectName: 'Connect API',
        branch,
        url: null,
        frames: [],
    });
    api.answer('bugPrepareFix', {ok: true, projectPath: PROJECT, worktreePath, branch, prompt});
    api.handle('bugFixStarted', (key, sessionId) =>
        mainInbox.change(key, (item) => ({
            ...startWork(item, 'working'),
            work: {branch, sessionId, pullRequest: null},
        })),
    );
    await page.keyboard.press('Meta+b');
    await expect(row(page, TRENDING)).toHaveAttribute('aria-selected', 'true');

    /* When */
    await page.keyboard.press('f');

    /* Then */
    await expect.poll(() => api.callsTo('openTerminal')).toHaveLength(1);
    const [sessionId, cwd, isNew, options] = api.callsTo('openTerminal')[0]!;
    expect(api.callsTo('bugPrepareFix')).toEqual([[`bug:${API}:${TRENDING}`]]);
    expect(cwd).toBe(PROJECT + '/.claude/worktrees/fix/bugsnag-5f2a91c0');
    expect(isNew).toBe(true);
    expect(options?.initialPrompt).toBe(prompt);
    expect(options?.initialPrompt).toContain('Fix this Bugsnag error from Connect API.');
    expect(options?.initialPrompt).toContain(`Bugsnag-Error: ${API} ${TRENDING}`);
    await expect.poll(() => api.callsTo('bugFixStarted')).toEqual([[`bug:${API}:${TRENDING}`, sessionId]]);

    /* When */
    await page.keyboard.press('Meta+b');

    /* Then */
    await expect(bugPage(page).getByRole('tab', {name: /^In progress/})).toContainText('1');
    await bugPage(page)
        .getByRole('tab', {name: /^In progress/})
        .click();
    await expect(row(page, TRENDING)).toContainText('Working');
});

test('Fix is off for a Bugsnag project linked to no local project', async ({page}) => {
    /* Given */
    await page.keyboard.press('Meta+b');

    /* When */
    await row(page, UNLINKED, ANDROID).click();

    /* Then */
    await expect(bugPage(page).getByRole('button', {name: /^Fix/})).toBeDisabled();
    await expect(bugPage(page).getByText('Link a project first: Settings → Bug manager.')).toBeVisible();
});

test('a bug seen again after its merge from an older release asks, and Treat as regressed brings it back unread', async ({
    page,
    api,
    mainInbox,
}) => {
    /* Given */
    api.handle('bugTreatAsRegressed', (key) =>
        mainInbox.change(key, (item) => markRegressed(updateFix(item, (fix) => ({...fix, seenAgain: null})))),
    );
    await page.keyboard.press('Meta+b');
    await bugPage(page).getByRole('tab', {name: /^Done/}).click();

    /* Then */
    await expect(row(page, SEEN_AGAIN)).toContainText(
        'Seen again after the merge, but these 3 events come from 4.12.0, a release without the fix (first in v4.12.1). Close it again?',
    );

    /* When */
    await row(page, SEEN_AGAIN).getByRole('button', {name: 'Treat as regressed'}).click();

    /* Then */
    await expect(row(page, SEEN_AGAIN)).toBeHidden();
    await bugPage(page)
        .getByRole('tab', {name: /^Inbox/})
        .click();
    await expect(row(page, SEEN_AGAIN)).toContainText('Regressed');
    await expect(row(page, SEEN_AGAIN)).toHaveClass(/is-unread/);
    expect(api.callsTo('bugTreatAsRegressed')).toEqual([[`bug:${API}:${SEEN_AGAIN}`]]);
});

test('the header says when Bugsnag was last read, and that the last read failed', async ({page, api, mainInbox}) => {
    /* Given */
    const read = {fetchedAt: FIXTURE_NOW - 3 * 60_000, refreshing: false, failed: false};
    await page.keyboard.press('Meta+b');

    /* When */
    await api.emit('onInboxChanged', {...mainInbox.summary(), freshness: {...NO_INBOX_FRESHNESS, bug: read}});

    /* Then */
    await expect(bugPage(page).getByTestId('freshness')).toHaveText('Updated 3m ago');

    /* When */
    await api.emit('onInboxChanged', {
        ...mainInbox.summary(),
        freshness: {...NO_INBOX_FRESHNESS, bug: {...read, failed: true}},
    });

    /* Then */
    await expect(bugPage(page).getByTestId('freshness')).toHaveText('Updated 3m ago · Couldn’t refresh');
});
