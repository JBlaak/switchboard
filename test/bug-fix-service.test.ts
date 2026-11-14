/**
 * The Bug manager page's Fix (#414): its worktree, branch and prompt, the
 * stages it follows through the PR, the merge that marks the error fixed in
 * Bugsnag once, and the events after the merge, judged.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BugFixService, SESSION_GRACE_MS} from '../src/application/services/bug-fix-service';
import {syncSource} from '../src/domain/inbox/items';
import type {BugsnagApi} from '../src/application/ports/bugsnag-api';
import type {BugsnagEvent} from '../src/domain/bugsnag/model';
import type {BugsnagSettings} from '../src/domain/bugsnag/connection';
import type {InboxItem} from '../src/domain/inbox/model';
import type {BranchPullRequest} from '../src/domain/inbox/stage';
import type {ActiveSession} from '../src/application/model/active-session';
import {DAY, NOW, PROJECT, THRESHOLDS, bug} from './support/inbox-fixtures';
import {FakeStartGit, fakeTimers, silentLog} from './support/fakes';

const ROOT = '/code/connect';
const ERROR = '5f2a91c0deadbeef00000001';
const KEY = `bug:${PROJECT}:${ERROR}`;
const BRANCH = 'fix/bugsnag-5f2a91c0';
const WORKTREE = `${ROOT}/.claude/worktrees/${BRANCH}`;
const REPO = 'movelab/connect';
const MERGED_AT = '2026-11-14T10:00:00Z';

interface World {
    linked: string | null;
    pr: BranchPullRequest | null;
    /** Sessions running, by worktree. */
    running: Set<string>;
    queue: number | null;
    tags: {name: string; at: string}[];
    /** Tags that contain the merge commit. */
    containing: Set<string>;
    tagged: boolean;
    events: BugsnagEvent[];
    fixFails: boolean;
    now: number;
}

function harness(overrides: Partial<World> = {}) {
    const world: World = {
        linked: ROOT,
        pr: null,
        running: new Set([WORKTREE]),
        queue: null,
        tags: [],
        containing: new Set(),
        tagged: true,
        events: [],
        fixFails: false,
        now: NOW,
        ...overrides,
    };
    const items = new Map<string, InboxItem>();
    const first = syncSource([], [bug(ERROR)], {
        now: NOW,
        complete: true,
        watchingSince: NOW - 30 * DAY,
        thresholds: THRESHOLDS,
        viewer: null,
    }).items[0]!;
    items.set(first.key, first);
    const fixed: string[] = [];
    const api: BugsnagApi = {
        listProjects: async () => [
            {
                id: PROJECT,
                name: 'Connect API',
                slug: 'connect-api',
                htmlUrl: 'https://app.bugsnag.com/movelab/connect-api',
            },
        ],
        listErrors: async () => ({errors: [], next: null, total: 0}),
        errorTrend: async () => [1, 2, 3, 4, 5, 6, 7].map((events) => ({from: '', to: '', events})),
        eventsSince: async () => world.events,
        eventDetail: async () => ({
            id: 'e1',
            receivedAt: '2026-11-13T08:00:00Z',
            appVersion: '3.18.2',
            releaseStage: 'production',
            frames: [
                {file: 'vendor/laravel/Queue.php', line: 130, method: 'call', inProject: false},
                {file: 'app/Jobs/SyncWorkoutJob.php', line: 88, method: 'handle', inProject: true},
            ],
        }),
        fix: async (projectId, errorId) => {
            if (world.fixFails) throw new Error('down');
            fixed.push(`${projectId} ${errorId}`);
        },
        linkIssue: async () => {},
    };
    const settings: BugsnagSettings = {
        projects: [{id: PROJECT, name: 'Connect API', optedIn: true, localProject: world.linked}],
        trending: THRESHOLDS,
    };
    const git = new FakeStartGit(ROOT);
    const service = new BugFixService({
        sessions: () => [],
        transcripts: {locations: () => []},
        git: git.port,
        remotes: {originUrl: async () => `git@github.com:${REPO}.git`},
        inbox: {
            item: (key) => items.get(key) ?? null,
            list: () => [...items.values()],
            update: (key, apply) => {
                const before = items.get(key);
                if (!before) return null;
                const after = apply(before);
                items.set(key, after);
                return after;
            },
        },
        bugsnag: {api: () => api, settings: () => settings, mcpMissing: () => false},
        github: {
            pullRequestForBranch: async (repo, branch) =>
                repo === REPO && branch === BRANCH ? {pr: world.pr} : {pr: null},
            recentTags: async () => world.tags,
            refContains: async (_repo, ref) => world.containing.has(ref),
        },
        mergeQueue: {placeOf: () => world.queue},
        sessionIn: (worktree) => world.running.has(worktree),
        releasesTagged: async () => world.tagged,
        clock: {now: () => world.now},
        timers: fakeTimers(),
        log: silentLog,
    });
    const item = (): InboxItem => items.get(KEY)!;
    return {service, world, item, fixed, git, items};
}

function openPr(overrides: Partial<BranchPullRequest> = {}): BranchPullRequest {
    return {
        number: 241,
        url: `https://github.com/${REPO}/pull/241`,
        state: 'open',
        checks: {state: 'pending', passed: 3, total: 14, failing: []},
        mergedAt: null,
        mergeCommit: null,
        ...overrides,
    };
}

const MERGED = openPr({
    state: 'merged',
    checks: {state: 'passing', passed: 14, total: 14, failing: []},
    mergedAt: MERGED_AT,
    mergeCommit: 'abc1234',
});

/** A Fix pressed and its session started. */
async function fixing(h: ReturnType<typeof harness>): Promise<void> {
    await h.service.prepareFix(KEY);
    h.service.fixStarted(KEY, 'session-1');
}

/** A Fix merged and marked fixed, with Bugsnag's last event after the merge. */
async function mergedAndSeenAgain(h: ReturnType<typeof harness>): Promise<void> {
    await fixing(h);
    h.world.pr = MERGED;
    await h.service.follow();
    h.items.set(KEY, {...h.item(), facts: {...bug(ERROR), lastSeen: '2026-11-15T08:00:00Z'}});
}

function event(appVersion: string | null, receivedAt = '2026-11-15T08:00:00Z'): BugsnagEvent {
    return {id: `${appVersion}-${receivedAt}`, receivedAt, appVersion, releaseStage: 'production'};
}

// ── Fix ──

test('Fix makes a worktree of the linked project on fix/bugsnag-<first 8 of the error id>', async () => {
    /* Given */
    const h = harness();

    /* When */
    const prepared = await h.service.prepareFix(KEY);

    /* Then */
    assert.equal(prepared.ok, true);
    assert.ok(prepared.ok);
    assert.equal(prepared.branch, BRANCH);
    assert.equal(prepared.worktreePath, WORKTREE);
    assert.ok(h.git.writes.some((write) => write.startsWith(`worktree add -b ${BRANCH} ${WORKTREE}`)));
});

test("Fix's prompt states the conventions: test first, the trailer, the PR and link_issue, and the frames", async () => {
    /* Given */
    const h = harness();

    /* When */
    const prepared = await h.service.prepareFix(KEY);

    /* Then */
    assert.ok(prepared.ok);
    assert.match(prepared.prompt, /failing test first/);
    assert.match(prepared.prompt, new RegExp(`Bugsnag-Error: ${PROJECT} ${ERROR}`));
    assert.match(prepared.prompt, /open a pull request/);
    assert.match(prepared.prompt, /link_issue/);
    assert.match(prepared.prompt, /app\/Jobs\/SyncWorkoutJob\.php:88 {2}handle\(\)/);
    assert.match(
        prepared.prompt,
        /https:\/\/app\.bugsnag\.com\/movelab\/connect-api\/errors\/5f2a91c0deadbeef00000001/,
    );
    assert.doesNotMatch(prepared.prompt, /\/fix-bugsnag/);
});

test('Fix on a Bugsnag project without a local project says to link one first', async () => {
    /* Given */
    const h = harness({linked: null});

    /* When */
    const prepared = await h.service.prepareFix(KEY);

    /* Then */
    assert.deepEqual(prepared, {ok: false, reason: 'Link a project first', unlinked: true});
    assert.deepEqual(h.git.writes, []);
});

test('the started Fix session puts the bug in progress, working, on its branch', async () => {
    /* Given */
    const h = harness();
    await h.service.prepareFix(KEY);

    /* When */
    h.service.fixStarted(KEY, 'session-1');

    /* Then */
    assert.deepEqual(h.item().state, {kind: 'inProgress', stage: 'working'});
    assert.equal(h.item().fix?.branch, BRANCH);
    assert.equal(h.item().fix?.worktree, WORKTREE);
    assert.equal(h.item().fix?.sessionId, 'session-1');
});

test("the session tray's link to the error a Fix works on names it, its project and its Bugsnag URL", async () => {
    /* Given */
    const h = harness();
    await fixing(h);
    const facts = h.item().facts;
    assert.equal(facts.kind, 'bug');

    /* When */
    const link = h.service.fixLink(WORKTREE);

    /* Then */
    assert.deepEqual(link, {
        title: [facts.errorClass, facts.message].filter(Boolean).join(': '),
        url: `https://app.bugsnag.com/movelab/connect-api/errors/${ERROR}`,
        project: 'Connect API',
    });
});

test('no Fix link for another worktree, nor before the Bugsnag project list is kept, which is then read for the next', async () => {
    /* Given */
    const h = harness();
    h.items.set(KEY, {
        ...h.item(),
        state: {kind: 'inProgress', stage: 'working'},
        fix: {worktree: WORKTREE} as InboxItem['fix'],
    });

    /* When */
    const before = h.service.fixLink(WORKTREE);
    const other = h.service.fixLink(`${ROOT}/.claude/worktrees/feat/other`);
    await new Promise((resolve) => setImmediate(resolve));
    const after = h.service.fixLink(WORKTREE);

    /* Then */
    assert.equal(before, null);
    assert.equal(other, null);
    assert.equal(after?.url, `https://app.bugsnag.com/movelab/connect-api/errors/${ERROR}`);
});

// ── Following ──

test("the stage follows the branch's PR through CI, failing checks and the queue", async () => {
    /* Given */
    const h = harness();
    await fixing(h);
    const stages: string[] = [];

    /* When */
    for (const pr of [
        openPr(),
        openPr({checks: {state: 'failing', passed: 13, total: 14, failing: ['e2e']}}),
        openPr({checks: {state: 'passing', passed: 14, total: 14, failing: []}}),
    ]) {
        h.world.pr = pr;
        await h.service.follow();
        stages.push(h.item().state.kind === 'inProgress' ? (h.item().state as {stage: string}).stage : '');
    }
    h.world.queue = 2;
    await h.service.follow();
    stages.push((h.item().state as {stage: string}).stage);

    /* Then */
    assert.deepEqual(stages, ['prCi', 'ciFailing', 'ready', 'queue']);
    assert.deepEqual(h.item().fix?.pr, {number: 241, url: `https://github.com/${REPO}/pull/241`});
    assert.equal(h.item().fix?.queuePosition, 2);
});

test('a session waiting on you needs you', async () => {
    /* Given */
    const h = harness();
    await fixing(h);

    /* When */
    h.service.cliStateChanged('session-1', {projectPath: WORKTREE} as ActiveSession, {kind: 'needs-attention'});
    await h.service.follow();

    /* Then */
    assert.deepEqual(h.item().state, {kind: 'inProgress', stage: 'needsYou'});
});

test('a session that ends without a PR puts the bug back in the inbox, read, tried', async () => {
    /* Given */
    const h = harness();
    await fixing(h);
    h.world.running.clear();

    /* When */
    h.service.sessionEnded('session-1', {projectPath: WORKTREE} as ActiveSession);
    await h.service.follow();

    /* Then */
    assert.deepEqual(h.item().state, {kind: 'read'});
    assert.equal(h.item().fix?.ended, 'noPr');
});

test('a session missing since a restart, without a PR, ends the work only after the grace', async () => {
    /* Given */
    const h = harness();
    await fixing(h);
    h.world.running.clear();

    /* When */
    await h.service.follow();
    const before = h.item().state.kind;
    h.world.now = NOW + SESSION_GRACE_MS;
    await h.service.follow();

    /* Then */
    assert.equal(before, 'inProgress');
    assert.deepEqual(h.item().state, {kind: 'read'});
});

test('Stop working on it puts the bug back in the inbox, read', async () => {
    /* Given */
    const h = harness();
    await fixing(h);

    /* When */
    h.service.stopWorking(KEY);

    /* Then */
    assert.deepEqual(h.item().state, {kind: 'read'});
    assert.equal(h.item().fix?.ended, 'stopped');
});

// ── The merge ──

test('a merged PR moves the bug to Done and marks the error fixed in Bugsnag', async () => {
    /* Given */
    const h = harness();
    await fixing(h);
    h.world.pr = MERGED;

    /* When */
    await h.service.follow();

    /* Then */
    assert.equal(h.item().state.kind, 'done');
    assert.deepEqual(h.fixed, [`${PROJECT} ${ERROR}`]);
    assert.equal(h.item().fix?.mergeCommit, 'abc1234');
    assert.equal(h.item().fix?.markedFixed, true);
});

test('the error is marked fixed exactly once, however often the merge is followed', async () => {
    /* Given */
    const h = harness();
    await fixing(h);
    h.world.pr = MERGED;

    /* When */
    await Promise.all([h.service.follow(), h.service.follow()]);
    await h.service.follow();
    await h.service.follow();

    /* Then */
    assert.equal(h.fixed.length, 1);
});

test('a failed mark is tried again on the next round', async () => {
    /* Given */
    const h = harness({fixFails: true});
    await fixing(h);
    h.world.pr = MERGED;
    await h.service.follow();

    /* When */
    h.world.fixFails = false;
    await h.service.follow();

    /* Then */
    assert.equal(h.fixed.length, 1);
    assert.equal(h.item().fix?.markedFixed, true);
});

// ── Seen again ──

test('events after the merge from an older release ask you, naming the tag with the fix', async () => {
    /* Given */
    const h = harness({
        tags: [
            {name: 'v4.12.1', at: '2026-11-14T12:00:00Z'},
            {name: 'v4.12.0', at: '2026-11-01T12:00:00Z'},
        ],
        containing: new Set(['v4.12.1']),
    });
    await mergedAndSeenAgain(h);
    h.world.events = [
        event('4.12.0'),
        event('4.12.0', '2026-11-15T07:00:00Z'),
        event('4.11.9', '2026-11-15T06:00:00Z'),
    ];

    /* When */
    await h.service.follow();

    /* Then */
    assert.equal(h.item().state.kind, 'done');
    assert.deepEqual(h.item().fix?.seenAgain, {events: 3, version: '4.12.0', tag: 'v4.12.1', tagged: true});
});

test('events after the merge from the release with the fix regress the bug, unread', async () => {
    /* Given */
    const h = harness({tags: [{name: 'v4.12.1', at: '2026-11-14T12:00:00Z'}], containing: new Set(['v4.12.1'])});
    await mergedAndSeenAgain(h);
    h.world.events = [event('4.12.1')];

    /* When */
    await h.service.follow();

    /* Then */
    assert.equal(h.item().state.kind, 'unread');
    assert.equal(h.item().signals?.regressed, true);
});

test('an untagged project always asks', async () => {
    /* Given */
    const h = harness({tagged: false});
    await mergedAndSeenAgain(h);
    h.world.events = [event('9.0.0')];

    /* When */
    await h.service.follow();

    /* Then */
    assert.deepEqual(h.item().fix?.seenAgain, {events: 1, version: '9.0.0', tag: null, tagged: false});
});

test('Close again marks it fixed again and stays in Done; the same events never ask twice', async () => {
    /* Given */
    const h = harness({tagged: false});
    await mergedAndSeenAgain(h);
    h.world.events = [event('9.0.0')];
    await h.service.follow();
    h.world.now = Date.parse('2026-11-15T09:00:00Z');

    /* When */
    await h.service.closeAgain(KEY);
    await h.service.follow();

    /* Then */
    assert.equal(h.item().state.kind, 'done');
    assert.equal(h.item().fix?.seenAgain, null);
    assert.equal(h.fixed.length, 2);
});

test('Treat as regressed puts it back in the inbox, unread, regressed', async () => {
    /* Given */
    const h = harness({tagged: false});
    await mergedAndSeenAgain(h);
    h.world.events = [event('9.0.0')];
    await h.service.follow();

    /* When */
    h.service.treatAsRegressed(KEY);

    /* Then */
    assert.equal(h.item().state.kind, 'unread');
    assert.equal(h.item().signals?.regressed, true);
    assert.equal(h.item().fix?.seenAgain, null);
});

// ── The detail ──

test("a bug's detail has its 7-day trend, releases, in-project frames and its Bugsnag link", async () => {
    /* Given */
    const h = harness();

    /* When */
    const detail = await h.service.detail(KEY);

    /* Then */
    assert.deepEqual(detail?.trend, [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(detail?.frames, [{line: 'app/Jobs/SyncWorkoutJob.php:88  handle()', inProject: true}]);
    assert.equal(detail?.last?.version, '3.18.2');
    assert.equal(detail?.url, `https://app.bugsnag.com/movelab/connect-api/errors/${ERROR}`);
});
