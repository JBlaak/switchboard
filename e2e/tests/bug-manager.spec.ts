/**
 * The Bug manager page (#414) wired into the real app: ⌘B opens it on the
 * inbox seeded into the database, grouped by local project with "Not
 * linked" last, a tile filters it, J moves the cursor and marks the row
 * seen, and F makes a worktree of the linked project on
 * `fix/bugsnag-<8 chars>` and starts Claude there with the Fix prompt, which
 * moves the bug to In progress.
 *
 * The tabs, tiles, groups, keys and stages are unit tested in
 * test/bug-page-slice.test.ts and test/bug-fix-service.test.ts; this proves
 * the IPC round-trip, the keyboard and the session start. No Bugsnag token
 * is saved, so the detail's reads answer nothing and nothing leaves the box.
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {test, expect} from '../support/test';
import {standardFixture, P} from '../fixtures/standard';
import {FakeCli} from '../support/fake-cli';
import type {Page} from '@playwright/test';
import type {BugFacts, InboxItem} from '../../src/domain/inbox/model';

const API = '6a0000000000000000000001';
const ANDROID = '6a0000000000000000000002';
const TRENDING = '5f2a91c0deadbeef00000001';
const QUIET = '5f2a91c0deadbeef00000002';
const UNLINKED = '7b11aa00deadbeef00000003';
const SEEN_AGAIN = '5f2a91c0deadbeef00000004';

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

test.use({
    fixture: {
        ...standardFixture(),
        inboxItems: [
            bugItem(
                API,
                TRENDING,
                {
                    errorClass: 'ErrorException',
                    message: 'Undefined array key "workout_id"',
                    lastSeen: '2026-11-12T11:00:00Z',
                },
                true,
            ),
            bugItem(API, QUIET, {errorClass: 'QueryException', message: 'Deadlock found'}),
            bugItem(ANDROID, UNLINKED, {errorClass: 'IllegalStateException', message: 'Fragment not attached'}),
            seenAgainItem(),
        ],
    },
});

function bugPage(page: Page) {
    return page.getByRole('region', {name: 'Bug manager'});
}

function row(page: Page, errorId: string, projectId = API) {
    return bugPage(page).locator(`[data-bug-key="bug:${projectId}:${errorId}"]`);
}

test('⌘B opens the Bug manager on its inbox; a tile filters it and J marks the next row seen', async ({page, home}) => {
    /* Given */
    await linkBugsnagProjects(page, home.projectPath(P.acmeApi));

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
    home,
}) => {
    /* Given */
    const project = home.projectPath(P.acmeApi);
    gitRepositoryOnGitHub(project);
    await linkBugsnagProjects(page, project);
    await page.keyboard.press('Meta+b');
    await expect(row(page, TRENDING)).toHaveAttribute('aria-selected', 'true');
    const before = fs.readdirSync(home.controlDir);

    /* When */
    await page.keyboard.press('f');

    /* Then */
    const started = () => fs.readdirSync(home.controlDir).filter((key) => !before.includes(key));
    await expect.poll(started).toHaveLength(1);
    const launch = await new FakeCli(home.controlDir, started()[0]!).launched();
    expect(launch.cwd).toBe(project + '/.claude/worktrees/fix/bugsnag-5f2a91c0');
    const prompt = launch.argv[launch.argv.length - 1]!;
    expect(prompt).toContain('Fix this Bugsnag error from Connect API.');
    expect(prompt).toContain('failing test first');
    expect(prompt).toContain(`Bugsnag-Error: ${API} ${TRENDING}`);
    expect(prompt).toContain('link_issue');
    expect(execFileSync('git', ['-C', launch.cwd, 'branch', '--show-current'], {encoding: 'utf8'}).trim()).toBe(
        'fix/bugsnag-5f2a91c0',
    );

    /* When */
    await page.keyboard.press('Meta+b');

    /* Then */
    await expect(bugPage(page).getByRole('tab', {name: /^In progress/})).toContainText('1');
    await bugPage(page)
        .getByRole('tab', {name: /^In progress/})
        .click();
    await expect(row(page, TRENDING)).toContainText('Working');
    await bugPage(page)
        .getByRole('tab', {name: /^Inbox/})
        .click();
});

test('Fix is off for a Bugsnag project linked to no local project', async ({page, home}) => {
    /* Given */
    await linkBugsnagProjects(page, home.projectPath(P.acmeApi));
    await page.keyboard.press('Meta+b');

    /* When */
    await row(page, UNLINKED, ANDROID).click();

    /* Then */
    await expect(bugPage(page).getByRole('button', {name: /^Fix/})).toBeDisabled();
    await expect(bugPage(page).getByText('Link a project first: Settings → Bug manager.')).toBeVisible();
});

test('a bug seen again after its merge from an older release asks, and Treat as regressed brings it back unread', async ({
    page,
    home,
}) => {
    /* Given */
    await linkBugsnagProjects(page, home.projectPath(P.acmeApi));
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
});

/** Settings → Bug manager as a user leaves it: Connect API linked to `projectPath`, Coach Android to nothing. */
async function linkBugsnagProjects(page: Page, projectPath: string): Promise<void> {
    await page.evaluate(
        async ({api, android, projectPath}) => {
            const global = (await window.api.getSetting<Record<string, unknown>>('global')) ?? {};
            await window.api.setSetting('global', {
                ...global,
                bugsnag: {
                    projects: [
                        {id: api, name: 'Connect API', optedIn: true, localProject: projectPath},
                        {id: android, name: 'Coach Android', optedIn: true, localProject: null},
                    ],
                    trending: {multiplier: 3, minEvents: 20},
                },
            });
        },
        {api: API, android: ANDROID, projectPath},
    );
}

/**
 * The project as a git repository whose origin is on GitHub, as a Fix needs,
 * with fetching pointed at a closed port so it fails at once and the worktree
 * starts from the local main, as it does offline.
 */
function gitRepositoryOnGitHub(project: string): void {
    const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], {stdio: 'pipe'});
    git('init', '--quiet', '--initial-branch=main');
    git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'Start',
    );
    git('remote', 'add', 'origin', 'https://github.com/acme/api.git');
    git('config', 'http.proxy', 'http://127.0.0.1:9');
}
