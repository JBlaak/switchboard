/**
 * How the project page's overview arrives: asked without plans and in full at
 * once, the answer without plans shows first but never takes a full one's
 * place; the last full answer is stored per project and shown as the page
 * opens, marked as being updated, with nothing claimed to be running.
 *
 * The service side (`plans: false`) is in test/project-overview-service.test.ts.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {NO_MEMORY} from '../src/renderer/state/project-page-slice';
import {
    STORED_OVERVIEWS_BUDGET,
    STORED_OVERVIEWS_KEPT,
    isStorable,
    parseStoredOverviews,
    storedOverviewFor,
    storedOverviewsWith,
    type StoredOverview,
} from '../src/renderer/state/stored-overviews';
import {
    pageRows,
    planRows,
    plansViewOf,
    pullRequestRows,
    pullRequestsViewOf,
} from '../src/renderer/ui/project-page/page-rows';
import {githubPart} from '../src/renderer/ui/project-page/page-state';
import {groupOverview} from '../src/domain/plan/project-overview';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {Plan} from '../src/domain/plan/model';
import type {ProjectIssue, ProjectOverview, ProjectPullRequest} from '../src/domain/project/overview';

const REPO = 'acme/app';
const APP = '/dev/app';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(stored: StoredOverview | null = null, projectPath = APP): RendererState {
    return run(initialRendererState(), {type: 'projectPageRestored', projectPath, memory: NO_MEMORY, stored});
}

function answered(overview: ProjectOverview, plans: boolean, merged = false): RendererEvent {
    return {type: 'projectOverviewAnswered', projectPath: overview.projectPath, closed: false, merged, plans, overview};
}

const NOW = Date.parse('2026-10-17T12:00:00Z');

/** The Pull requests section's rows on `page`, group after group. */
function shownPullRequests(page: RendererState['projectPage']) {
    return pullRequestsViewOf(page, APP, NOW)!.flatMap((group) => group.rows);
}

// ── An overview: a plan whose issue a session works on, a PR closing it, a loose issue, two checkouts ──

const LOGIN: Plan = {
    repository: REPO,
    number: 10,
    title: 'Login rework',
    parent: null,
    outside: [],
    issues: [
        {
            repository: REPO,
            number: 11,
            title: 'Redirect loop',
            state: 'open',
            closedAs: null,
            updatedAt: '2026-10-10T00:00:00Z',
            blockedBy: [],
            pullRequests: [],
            summary: '',
            acceptance: [],
        },
    ],
};

function issue(number: number, fields: Partial<ProjectIssue> = {}): ProjectIssue {
    return {
        repository: REPO,
        number,
        title: 'Issue ' + number,
        state: 'open',
        updatedAt: '2026-10-10T00:00:00Z',
        labels: [],
        parent: null,
        subIssueCount: 0,
        ...fields,
    };
}

const PR: ProjectPullRequest = {
    repository: REPO,
    number: 20,
    title: 'Stop the redirect loop',
    state: 'open',
    draft: false,
    headRef: 'fix/redirect',
    updatedAt: '2026-10-17T00:00:00Z',
    checks: {state: 'passing', failing: 0},
    review: null,
    closes: [11],
    wait: {
        closedAt: null,
        failedChecks: [],
        cancelledChecks: [],
        reviewRequestedFromYou: false,
        reviewRequestedFromOthers: false,
        unresolvedThreads: 0,
        mergeable: 'mergeable',
        behindBase: null,
    },
};

/** The full answer, or (`plans` false) the one without plans, as main gives them. */
function overview(plans = true, fields: Partial<ProjectOverview> = {}): ProjectOverview {
    const groups = groupOverview<ProjectIssue, ProjectPullRequest>({
        repository: REPO,
        plans: plans ? [{plan: LOGIN, state: 'open', updatedAt: '2026-10-10T00:00:00Z'}] : [],
        issues: [issue(10, {subIssueCount: 1}), issue(11, {parent: 10}), issue(30)],
        pullRequests: [PR],
        sessions: {owners: {[REPO + '#11']: 's1'}, running: new Set(['s1'])},
    });
    return {
        projectPath: APP,
        remote: false,
        repository: REPO,
        github: {
            ok: true,
            fetchedAt: 1_000,
            stale: false,
            plansPending: !plans,
            mergeQueue: null,
            ...groups,
            plans: plans ? groups.plans : [],
        },
        worktrees: [
            {
                path: APP,
                branch: 'main',
                main: true,
                locked: false,
                changedFiles: 0,
                ahead: 0,
                merged: false,
                lastCommitAt: null,
                running: ['s1'],
            },
        ],
        running: ['s1'],
        ...fields,
    };
}

/** `o` with these pull requests, each closing nothing in a plan. */
function withPullRequests(o: ProjectOverview, pullRequests: ProjectPullRequest[]): ProjectOverview {
    assert.ok(o.github?.ok);
    return {
        ...o,
        github: {
            ...o.github,
            pullRequests: pullRequests.map((pullRequest) => ({pullRequest, closes: [], plan: null})),
        },
    };
}

function stored(o: ProjectOverview = overview()): StoredOverview {
    return storedOverviewFor(
        parseStoredOverviews(storedOverviewsWith([], {overview: o, closed: false, merged: false})),
        APP,
        false,
        false,
    )!;
}

// ── The answer without plans, and the full one ──

test('the answer without plans shows its pull requests and loose issues, with the plans still coming', () => {
    /* Given */
    const state = opened();

    /* When */
    const next = run(state, answered(overview(false), false));

    /* Then */
    const page = next.projectPage;
    const plans = plansViewOf(page, APP)!;
    assert.equal(plans.plansPending, true);
    assert.deepEqual(plans.plans, []);
    assert.deepEqual(
        plans.loose.map((row) => row.issue.number),
        [30],
    );
    assert.deepEqual(
        shownPullRequests(page).map((row) => [row.pullRequest.number, row.plan?.number]),
        [[20, 10]],
    );
});

test('with the plans still coming, the cursor walks the pull requests, then the loose issues', () => {
    /* Given */
    const page = run(opened(), answered(overview(false), false)).projectPage;

    /* When */
    const rows = pageRows({
        pullRequests: pullRequestRows(pullRequestsViewOf(page, APP, NOW)!),
        plans: planRows(plansViewOf(page, APP)!),
        sessions: [],
    });

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.id),
        ['pr:acme/app#20', 'issue:acme/app#30'],
    );
});

test('the full answer replaces the one without plans', () => {
    /* Given */
    const state = run(opened(), answered(overview(false), false));

    /* When */
    const next = run(state, answered(overview(), true));

    /* Then */
    const plans = plansViewOf(next.projectPage, APP)!;
    assert.equal(plans.plansPending, false);
    assert.deepEqual(
        plans.plans.map((row) => row.plan.plan.number),
        [10],
    );
});

test('an answer without plans that lands after the full one is dropped', () => {
    /* Given */
    const state = run(opened(), answered(overview(), true));

    /* When */
    const next = run(state, answered(overview(false), false));

    /* Then */
    assert.equal(next.projectPage, state.projectPage);
});

test('after Show merged flips, the answer without plans brings its pull requests and leaves the plans on screen', () => {
    /* Given */
    const state = run(opened(), answered(overview(), true), {type: 'projectShowMergedToggled'});
    const merged: ProjectPullRequest = {...PR, number: 19, state: 'merged', closes: []};

    /* When */
    const next = run(state, answered(withPullRequests(overview(false), [PR, merged]), false, true));

    /* Then */
    const page = next.projectPage;
    const plans = plansViewOf(page, APP)!;
    assert.equal(plans.plansPending, false);
    assert.equal(plans.plans.length, 1);
    assert.deepEqual(
        shownPullRequests(page).map((row) => row.pullRequest.number),
        [20, 19],
    );
    assert.equal(page.overviewFrom?.merged, false);
});

// ── The stored answer ──

test('a page opens on the answer stored from its last visit, marked as being updated', () => {
    /* Given */
    const last = stored();

    /* When */
    const state = opened(last);

    /* Then */
    assert.equal(state.projectPage.overview, last.overview);
    assert.deepEqual(state.projectPage.overviewFrom, {closed: false, merged: false, stored: true});
    assert.equal(githubPart(state.projectPage.overview, APP).kind, 'ok');
});

test('reopening the project the page still holds keeps that answer over the stored one', () => {
    /* Given */
    const fresh = overview();
    const held = run(opened(), answered(fresh, true));

    /* When */
    const state = run(held, {type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY, stored: stored()});

    /* Then */
    assert.equal(state.projectPage.overview, fresh);
    assert.equal(state.projectPage.overviewFrom?.stored, false);
});

test('the answer without plans brings its fresh pull requests, worktrees and running sessions into the stored one, its plans kept', () => {
    /* Given */
    const state = opened(stored());
    const renamed: ProjectPullRequest = {...PR, title: 'Stop the redirect loop, for good'};

    /* When */
    const next = run(state, answered(withPullRequests(overview(false), [renamed]), false));

    /* Then */
    const page = next.projectPage;
    assert.deepEqual(
        shownPullRequests(page).map((row) => row.pullRequest.title),
        ['Stop the redirect loop, for good'],
    );
    assert.deepEqual(page.overview?.running, ['s1']);
    assert.deepEqual(page.overview?.worktrees[0].running, ['s1']);
    assert.equal(plansViewOf(page, APP)!.plans.length, 1);
    assert.equal(page.overviewFrom?.stored, true);
});

test('the full answer replaces the stored one, and the page is no longer updating', () => {
    /* Given */
    const state = opened(stored());
    const fresh = overview();

    /* When */
    const next = run(state, answered(fresh, true));

    /* Then */
    assert.equal(next.projectPage.overview, fresh);
    assert.equal(next.projectPage.overviewFrom?.stored, false);
});

test('when GitHub cannot be asked, the stored GitHub part stays, marked stale, rather than the message', () => {
    /* Given */
    const state = opened(stored());

    /* When */
    const next = run(state, answered(overview(true, {github: {ok: false, reason: 'unreachable'}}), true));

    /* Then */
    const part = githubPart(next.projectPage.overview, APP);
    assert.deepEqual(part, {kind: 'ok', stale: true, fetchedAt: 1_000});
    assert.equal(next.projectPage.overviewFrom?.stored, false);
});

// ── The store ──

test('a stored answer claims no session is running', () => {
    /* Given */
    const full = overview();

    /* When */
    const last = stored(full);

    /* Then */
    const github = last.overview.github;
    assert.ok(github?.ok);
    assert.deepEqual(last.overview.running, []);
    assert.deepEqual(last.overview.worktrees[0].running, []);
    assert.equal(github.plans[0].running, false);
    assert.deepEqual(github.plans[0].issues[0].status, {kind: 'pull-request', pullRequest: PR});
    assert.equal(github.plans[0].issues[0].session, 's1');
});

test('one answer is stored per project and options, newest first, the oldest dropped past the cap', () => {
    /* Given */
    let record = '';
    for (let i = 0; i < STORED_OVERVIEWS_KEPT + 2; i++) {
        record = storedOverviewsWith(parseStoredOverviews(record), {
            overview: overview(true, {projectPath: '/dev/p' + i}),
            closed: false,
            merged: false,
        });
    }

    /* When */
    record = storedOverviewsWith(parseStoredOverviews(record), {
        overview: overview(true, {projectPath: '/dev/p5'}),
        closed: false,
        merged: false,
    });
    record = storedOverviewsWith(parseStoredOverviews(record), {
        overview: overview(true, {projectPath: '/dev/p5'}),
        closed: true,
        merged: false,
    });
    const entries = parseStoredOverviews(record);

    /* Then */
    assert.equal(entries.length, STORED_OVERVIEWS_KEPT);
    assert.deepEqual(
        entries.slice(0, 3).map((entry) => [entry.overview.projectPath, entry.closed]),
        [
            ['/dev/p5', true],
            ['/dev/p5', false],
            ['/dev/p21', false],
        ],
    );
    assert.equal(storedOverviewFor(entries, '/dev/p0', false, false), null);
    assert.equal(storedOverviewFor(entries, '/dev/p5', false, true), null);
});

test('the store stays within its budget, the oldest dropped first', () => {
    /* Given */
    const big = (path: string): StoredOverview => ({
        overview: overview(true, {projectPath: path, repository: 'x'.repeat(STORED_OVERVIEWS_BUDGET / 3)}),
        closed: false,
        merged: false,
    });

    /* When */
    let record = storedOverviewsWith([], big('/dev/a'));
    record = storedOverviewsWith(parseStoredOverviews(record), big('/dev/b'));
    record = storedOverviewsWith(parseStoredOverviews(record), big('/dev/c'));

    /* Then */
    assert.ok(record.length <= STORED_OVERVIEWS_BUDGET);
    assert.deepEqual(
        parseStoredOverviews(record).map((entry) => entry.overview.projectPath),
        ['/dev/c', '/dev/b'],
    );
});

test('a record that is not ours reads as empty', () => {
    /* Given */
    const records = [null, '', 'not json', '[]', '{"v":0,"entries":[]}', '{"v":1,"entries":[{"closed":false}]}'];

    /* When */
    const read = records.map(parseStoredOverviews);

    /* Then */
    assert.deepEqual(read, [[], [], [], [], [], []]);
});

test('a record from before the pull requests carried their wait reads is not read', () => {
    /* Given: the shape builds before #332 wrote, whose rows the page can't draw */
    const record = JSON.parse(storedOverviewsWith([], {overview: overview(), closed: false, merged: false}));
    const old = JSON.stringify({...record, v: 1});

    /* When */
    const read = parseStoredOverviews(old);

    /* Then */
    assert.deepEqual(read, []);
});

test('only a full, fresh answer for a local project is stored, not an agentless remote’s', () => {
    /* Given */
    const fresh = overview();
    const github = fresh.github;
    assert.ok(github?.ok);

    /* When */
    const storable = [
        fresh,
        overview(false),
        {...fresh, github: {...github, stale: true}},
        {...fresh, github: null},
        {...fresh, github: {ok: false as const, reason: 'unreachable' as const}},
        {...fresh, projectPath: 'ssh://me@host:22/app', remote: true},
    ].map((answer) => isStorable(answer));

    /* Then */
    assert.deepEqual(storable, [true, false, false, true, false, false]);
});

test('a VM project’s full, fresh answer is stored, even one that still says remote', () => {
    /* Given */
    const fresh = overview(true, {projectPath: 'ssh://me@vm:22/app', remote: true});
    const github = fresh.github;
    assert.ok(github?.ok);

    /* When */
    const storable = [fresh, {...fresh, remote: false}, {...fresh, github: {...github, stale: true}}].map((answer) =>
        isStorable(answer, true),
    );

    /* Then */
    assert.deepEqual(storable, [true, true, false]);
});
