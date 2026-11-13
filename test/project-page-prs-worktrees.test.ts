/**
 * The project page's Pull requests and Worktrees sections and its edge states
 * (#175): Show merged and a worktree's start in the project-page slice, which
 * PR and worktree rows are on screen and what they say, the cursor rows and
 * keys they add, and which state the page is in from the overview's answer.
 *
 * The page in the real app, with a stubbed overview, is in
 * e2e/tests/project-page.spec.ts.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {NO_MEMORY, overviewRequest} from '../src/renderer/state/project-page-slice';
import {
    checksPill,
    cursorId,
    pageRows,
    planRows,
    plansView,
    pullRequestRows,
    pullRequestsView,
    worktreeRows,
    worktreesView,
    type PullRequestGroupOnScreen,
} from '../src/renderer/ui/project-page/page-rows';
import {pageKeyAction} from '../src/renderer/ui/project-page/page-keys';
import {
    AUTH_COMMAND,
    ageInWords,
    cleanConfirm,
    cleanableWorktrees,
    githubPart,
    remoteHost,
    showsWorktrees,
    staleLine,
    unavailableMessage,
} from '../src/renderer/ui/project-page/page-state';
import {groupOverview} from '../src/domain/plan/project-overview';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {Plan, PlanIssue} from '../src/domain/plan/model';
import type {ProjectIssue, ProjectOverview, ProjectPullRequest, WorktreeOverview} from '../src/domain/project/overview';
import type {MergeQueue} from '../src/domain/project/merge-queue';

const REPO = 'acme/app';
const APP = '/dev/app';
const NOW = Date.parse('2026-10-17T12:00:00Z');
const SHOWN = {showMerged: false, filter: '', now: NOW};

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(projectPath = APP): RendererState {
    return run(initialRendererState(), {type: 'projectPageRestored', projectPath, memory: NO_MEMORY});
}

// ── An overview: a plan of two issues, PRs open, draft and merged, and four checkouts ──

function planIssue(number: number, title: string): PlanIssue {
    return {
        repository: REPO,
        number,
        title,
        state: 'open',
        closedAs: null,
        updatedAt: '2026-10-10T00:00:00Z',
        blockedBy: [],
        pullRequests: [],
        summary: '',
        acceptance: [],
    };
}

const LOGIN: Plan = {
    repository: REPO,
    number: 10,
    title: 'Login rework',
    parent: null,
    outside: [],
    issues: [planIssue(11, 'Cookie store'), planIssue(12, 'Redirect loop')],
};

function issue(number: number, title: string, fields: Partial<ProjectIssue> = {}): ProjectIssue {
    return {
        repository: REPO,
        number,
        title,
        state: 'open',
        updatedAt: '2026-10-10T00:00:00Z',
        labels: [],
        parent: null,
        subIssueCount: 0,
        ...fields,
    };
}

function pullRequest(
    number: number,
    title: string,
    headRef: string,
    fields: Partial<ProjectPullRequest> = {},
): ProjectPullRequest {
    return {
        repository: REPO,
        number,
        title,
        state: 'open',
        draft: false,
        mine: true,
        headRef,
        updatedAt: '2026-10-17T00:00:00Z',
        checks: {state: 'passing', failing: 0},
        review: null,
        closes: [],
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
        ...fields,
    };
}

function worktree(path: string, fields: Partial<WorktreeOverview> = {}): WorktreeOverview {
    return {
        path,
        branch: null,
        main: false,
        locked: false,
        changedFiles: 0,
        ahead: 0,
        merged: false,
        lastCommitAt: null,
        running: [],
        ...fields,
    };
}

const WORKTREES: WorktreeOverview[] = [
    worktree(APP + '/.claude/worktrees/old', {branch: 'old-work', merged: true, lastCommitAt: 1_000}),
    worktree(APP + '/.claude/worktrees/limiter', {branch: 'rate-limiter', ahead: 1, lastCommitAt: 3_000}),
    worktree(APP, {branch: 'main', main: true, lastCommitAt: 500}),
    worktree(APP + '/.claude/worktrees/redirect', {
        branch: 'fix/redirect',
        changedFiles: 2,
        ahead: 3,
        lastCommitAt: 4_000,
        running: ['s1'],
    }),
    worktree(APP + '/.claude/worktrees/detached', {lastCommitAt: null}),
];

function overview(fields: Partial<ProjectOverview> = {}): ProjectOverview {
    const issues = [
        issue(10, 'Login rework', {subIssueCount: 2}),
        issue(11, 'Cookie store', {parent: 10}),
        issue(12, 'Redirect loop', {parent: 10}),
    ];
    const sessions = {owners: {}, running: new Set<string>()};
    const plans = [{plan: LOGIN, state: 'open' as const, updatedAt: '2026-10-10T00:00:00Z'}];
    const groups = groupOverview<ProjectIssue, ProjectPullRequest>({
        repository: REPO,
        plans,
        issues,
        sessions,
        pullRequests: [
            pullRequest(20, 'Stop the redirect loop', 'fix/redirect', {
                closes: [12],
                checks: {state: 'running', failing: 0},
            }),
            pullRequest(21, 'Try a rate limiter', 'rate-limiter', {draft: true}),
            pullRequest(22, 'Bump express', 'dependabot/express', {
                checks: {state: 'failing', failing: 2},
                review: 'review_required',
            }),
        ],
    });
    // Merged ones come after the open ones, grouped on their own, as main answers them.
    groups.pullRequests.push(
        ...groupOverview<ProjectIssue, ProjectPullRequest>({
            repository: REPO,
            plans: [],
            issues: [],
            sessions,
            pullRequests: [pullRequest(19, 'Old work', 'old-work', {state: 'merged', closes: [11]})],
        }).pullRequests,
    );
    return {
        projectPath: APP,
        remote: false,
        repository: REPO,
        github: {ok: true, fetchedAt: 0, stale: false, plansPending: false, mergeQueue: null, ...groups},
        worktrees: WORKTREES,
        running: ['s1'],
        ...fields,
    };
}

function numbers(groups: readonly PullRequestGroupOnScreen[]): number[] {
    return groups.flatMap((group) => group.rows.map((row) => row.pullRequest.number));
}

/** The section's groups for `o`. */
function prGroups(o: ProjectOverview, options: Partial<typeof SHOWN> = {}): PullRequestGroupOnScreen[] {
    return pullRequestsView(github(o), o.worktrees, {...SHOWN, ...options});
}

/** `o` with these PRs instead of its own, each closing the issues it says, merge queue pills as given. */
function withPullRequests(
    o: ProjectOverview,
    pullRequests: ProjectPullRequest[],
    pills: MergeQueue['pills'] = {},
): ProjectOverview {
    const groups = github(o);
    return {
        ...o,
        github: {
            ...groups,
            mergeQueue: {
                head: null,
                entries: [],
                failed: [],
                outside: [],
                unknown: [],
                counts: {queued: 0, held: 0, failed: 0},
                stalled: false,
                clearsInMs: null,
                runMs: null,
                clearsAtPlace: null,
                pills,
            },
            pullRequests: pullRequests.map((pullRequest) => ({
                pullRequest,
                closes: pullRequest.closes.map((number) => ({repository: REPO, number})),
                plan: null,
            })),
        },
    };
}

function github(o: ProjectOverview) {
    assert.ok(o.github?.ok);
    return o.github;
}

// ── Show merged and a worktree's start, in the slice ──

test('Show merged flips, and the overview is asked for with merged PRs as it says', () => {
    /* Given */
    const onPage = run(
        initialRendererState(),
        {type: 'projectOpened', projectPath: APP, view: {kind: 'overview'}},
        {type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY},
    );

    /* When */
    const shown = run(onPage, {type: 'projectShowMergedToggled'});

    /* Then */
    assert.deepEqual(overviewRequest(onPage), {projectPath: APP, closed: false, merged: false});
    assert.deepEqual(overviewRequest(shown), {projectPath: APP, closed: false, merged: true});
});

test('an answer asked before Show merged flipped is dropped', () => {
    /* Given */
    const shown = run(opened(), {type: 'projectShowMergedToggled'});

    /* When */
    const stale = run(shown, {
        type: 'projectOverviewAnswered',
        plans: true,
        projectPath: APP,
        closed: false,
        merged: false,
        overview: overview(),
    });
    const fresh = run(shown, {
        type: 'projectOverviewAnswered',
        plans: true,
        projectPath: APP,
        closed: false,
        merged: true,
        overview: overview(),
    });

    /* Then */
    assert.equal(stale.projectPage.overview, null);
    assert.ok(fresh.projectPage.overview);
});

test('Show merged starts off each time a page opens', () => {
    /* Given */
    const shown = run(opened(), {type: 'projectShowMergedToggled'});

    /* When */
    const reopened = run(shown, {type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY});

    /* Then */
    assert.equal(shown.projectPage.showMerged, true);
    assert.equal(reopened.projectPage.showMerged, false);
});

test('starting a session in a worktree shows it starting, then clears, or says why it did not start', () => {
    /* Given */
    const path = APP + '/.claude/worktrees/limiter';
    const asked = run(opened(), {type: 'projectWorktreeStartAsked', path});

    /* When */
    const started = run(asked, {type: 'projectWorktreeStartAnswered', path, result: {ok: true, sessionId: 's2'}});
    const failed = run(asked, {type: 'projectWorktreeStartAnswered', path, result: {ok: false, reason: 'No claude'}});
    const other = run(asked, {
        type: 'projectWorktreeStartAnswered',
        path: APP,
        result: {ok: false, reason: 'No claude'},
    });

    /* Then */
    assert.deepEqual(asked.projectPage.worktreeStart, {path, phase: 'starting'});
    assert.equal(started.projectPage.worktreeStart, null);
    assert.deepEqual(failed.projectPage.worktreeStart, {path, phase: 'failed', reason: 'No claude'});
    assert.equal(other.projectPage, asked.projectPage);
});

test('Clean shows it is cleaning, then clears, or keeps the worktrees git would not remove with why', () => {
    /* Given */
    const path = APP + '/.claude/worktrees/old';
    const asked = run(opened(), {type: 'projectWorktreesCleanAsked'});

    /* When */
    const cleaned = run(asked, {
        type: 'projectWorktreesCleanAnswered',
        projectPath: APP,
        result: {removed: [path], failed: []},
    });
    const refused = run(asked, {
        type: 'projectWorktreesCleanAnswered',
        projectPath: APP,
        result: {removed: [], failed: [{path, reason: 'contains modified or untracked files'}]},
    });
    const other = run(asked, {
        type: 'projectWorktreesCleanAnswered',
        projectPath: '/dev/other',
        result: {removed: [], failed: [{path, reason: 'no'}]},
    });

    /* Then */
    assert.deepEqual(asked.projectPage.worktreeClean, {phase: 'cleaning'});
    assert.equal(cleaned.projectPage.worktreeClean, null);
    assert.deepEqual(refused.projectPage.worktreeClean, {
        phase: 'failed',
        failed: [{path, reason: 'contains modified or untracked files'}],
    });
    assert.equal(other.projectPage, asked.projectPage);
    assert.equal(
        run(refused, {type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY}).projectPage.worktreeClean,
        null,
    );
});

test('Clean offers the merged worktrees with no changes and no session running, and asks with how many', () => {
    /* Given */
    const o = overview({
        worktrees: [
            ...WORKTREES,
            worktree(APP + '/.claude/worktrees/done', {branch: 'done', merged: true}),
            worktree(APP + '/.claude/worktrees/dirty', {branch: 'dirty', merged: true, changedFiles: 1}),
            worktree(APP + '/.claude/worktrees/locked', {branch: 'locked', merged: true, locked: true}),
        ],
    });

    /* When */
    const cleanable = cleanableWorktrees(o, APP);

    /* Then */
    assert.deepEqual(
        cleanable.map((w) => w.path),
        [APP + '/.claude/worktrees/old', APP + '/.claude/worktrees/done'],
    );
    assert.match(cleanConfirm(2), /^Remove 2 merged worktrees /);
    assert.match(cleanConfirm(1), /^Remove 1 merged worktree /);
});

test('no Clean before the answer, for another project’s answer, or for an ssh project', () => {
    /* Given */
    const vm = 'ssh://dev@vm.local:2222/home/dev/app';

    /* When */
    const answers = [
        cleanableWorktrees(null, APP),
        cleanableWorktrees(overview(), '/dev/other'),
        cleanableWorktrees({...overview(), projectPath: vm, remote: true}, vm),
    ];

    /* Then */
    assert.deepEqual(answers, [[], [], []]);
});

// ── Pull requests ──

test('the section groups the open PRs by what they wait on, and Show merged adds the older merged ones last', () => {
    /* Given */
    const o = overview();

    /* When */
    const open = prGroups(o);
    const all = prGroups(o, {showMerged: true});

    /* Then */
    assert.deepEqual(
        open.map((group) => [group.title, numbers([group])]),
        [
            ['Needs you', [21, 22]],
            ['Waiting on CI', [20]],
        ],
    );
    assert.deepEqual(
        all.map((group) => [group.title, numbers([group])]),
        [
            ['Needs you', [21, 22]],
            ['Waiting on CI', [20]],
            ['Merged earlier', [19]],
        ],
    );
});

test('each PR says its open point in words', () => {
    /* When */
    const groups = prGroups(overview(), {showMerged: true});

    /* Then */
    assert.deepEqual(
        groups.flatMap((group) => group.rows.map((row) => [row.pullRequest.number, row.wait.openPoint])),
        [
            [21, 'draft'],
            [22, 'CI failing · waiting on review'],
            [20, 'CI running'],
            [19, 'merged'],
        ],
    );
});

test('a PR that closes an issue in a plan carries that plan for its chip, and is the issue’s PR pill', () => {
    /* Given */
    const o = overview();

    /* When */
    const rows = prGroups(o).flatMap((group) => group.rows);
    const plans = plansView(github(o), {
        expandedPlans: [REPO + '#10'],
        showClosed: false,
        filter: '',
        looseExpanded: false,
    });

    /* Then */
    assert.deepEqual(rows.find((row) => row.pullRequest.number === 20)?.plan, {repository: REPO, number: 10});
    assert.equal(rows.find((row) => row.pullRequest.number === 21)?.plan, null);
    const redirect = plans.plans[0].issues.find((row) => row.issue.number === 12);
    assert.equal(redirect?.status?.kind, 'pull-request');
    assert.equal(redirect?.status?.kind === 'pull-request' && redirect.status.pullRequest.number, 20);
});

test('the filter finds a PR by number, title or head branch', () => {
    /* Given */
    const o = overview();

    /* When */
    const byBranch = prGroups(o, {filter: 'dependabot'});
    const byNumber = prGroups(o, {filter: '#21'});
    const byTitle = prGroups(o, {filter: 'redirect LOOP'});

    /* Then */
    assert.deepEqual(numbers(byBranch), [22]);
    assert.deepEqual(numbers(byNumber), [21]);
    assert.deepEqual(numbers(byTitle), [20]);
});

test('failing CI waits on CI while a session runs in the worktree of its head branch, and needs you otherwise', () => {
    /* Given */
    const failing = {checks: {state: 'failing', failing: 1}} as const;
    const o = withPullRequests(overview(), [
        pullRequest(30, 'Worked on', 'fix/redirect', failing),
        pullRequest(31, 'Left alone', 'rate-limiter', failing),
    ]);

    /* When */
    const groups = prGroups(o);

    /* Then */
    assert.deepEqual(
        groups.map((group) => [group.group, numbers([group])]),
        [
            ['needs-you', [31]],
            ['waiting-on-ci', [30]],
        ],
    );
});

test('failing CI waits on CI while the session that owns an issue it closes is running', () => {
    /* Given */
    const base = overview();
    const owned = groupOverview<ProjectIssue, ProjectPullRequest>({
        repository: REPO,
        plans: [],
        issues: [issue(40, 'Owned')],
        pullRequests: [],
        sessions: {owners: {[REPO + '#40']: 's9'}, running: new Set(['s9'])},
    });
    const o = withPullRequests({...base, github: {...github(base), loose: owned.loose}}, [
        pullRequest(32, 'Closes the owned issue', 'elsewhere', {checks: {state: 'failing', failing: 1}, closes: [40]}),
    ]);

    /* When */
    const groups = prGroups(o);

    /* Then */
    assert.deepEqual(
        groups.map((group) => group.group),
        ['waiting-on-ci'],
    );
});

test('a PR merged or closed today shows without Show merged; one closed earlier never shows', () => {
    /* Given */
    const closedAt = (at: string): Partial<ProjectPullRequest> => ({
        wait: {...pullRequest(0, '', '').wait, closedAt: at},
    });
    const o = withPullRequests(overview(), [
        pullRequest(50, 'Merged today', 'a', {state: 'merged', ...closedAt('2026-10-17T09:00:00Z')}),
        pullRequest(51, 'Closed today', 'b', {state: 'closed', ...closedAt('2026-10-17T10:00:00Z')}),
        pullRequest(52, 'Merged last week', 'c', {state: 'merged', ...closedAt('2026-10-10T09:00:00Z')}),
        pullRequest(53, 'Closed last week', 'd', {state: 'closed', ...closedAt('2026-10-10T09:00:00Z')}),
    ]);

    /* When */
    const hidden = prGroups(o);
    const shown = prGroups(o, {showMerged: true});

    /* Then */
    assert.deepEqual(
        hidden.map((group) => [group.title, numbers([group])]),
        [['Merged or closed today', [50, 51]]],
    );
    assert.deepEqual(
        shown.map((group) => [group.title, numbers([group])]),
        [
            ['Merged or closed today', [50, 51]],
            ['Merged earlier', [52]],
        ],
    );
});

test('a PR in the merge queue waits on CI, and one the queue failed needs you', () => {
    /* Given */
    const o = withPullRequests(
        overview(),
        [pullRequest(60, 'Queued', 'q', {review: 'approved'}), pullRequest(61, 'Failed', 'f', {review: 'approved'})],
        {
            60: {kind: 'queued', text: 'queued · 2nd', title: 'Second in the merge queue'},
            61: {kind: 'failed', text: 'queue failed', title: 'The merge queue gave up'},
        },
    );

    /* When */
    const groups = prGroups(o);

    /* Then */
    assert.deepEqual(
        groups.flatMap((group) => group.rows.map((row) => [row.pullRequest.number, group.group, row.wait.openPoint])),
        [
            [61, 'needs-you', 'merge queue failed'],
            [60, 'waiting-on-ci', ''],
        ],
    );
});

test('the checks pill says passing, running or how many fail, and nothing without checks', () => {
    /* When */
    const pills = [
        checksPill({state: 'passing', failing: 0}),
        checksPill({state: 'running', failing: 0}),
        checksPill({state: 'failing', failing: 2}),
        checksPill({state: 'none', failing: 0}),
    ];

    /* Then */
    assert.deepEqual(pills, [
        {tone: 'passing', text: '✓ passing'},
        {tone: 'running', text: '● running'},
        {tone: 'failing', text: '✕ 2 failing'},
        null,
    ]);
});

// ── Worktrees ──

test('worktrees list the main checkout first, then the rest by last commit, newest first', () => {
    /* When */
    const rows = worktreesView(overview(), '');

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.title),
        ['main', 'fix/redirect', 'rate-limiter', 'old-work', 'detached'],
    );
});

test('a worktree row says what changed, how far ahead it is and its PR; the main one names its folder', () => {
    /* When */
    const rows = worktreesView(overview(), '');

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.meta),
        [
            'app · clean',
            '2 changed · ↑3 · PR #20',
            'clean · ↑1 · PR #21',
            'merged in #19 · safe to remove',
            'detached · clean',
        ],
    );
});

test('a merged worktree with no merged PR known still says it is safe to remove', () => {
    /* Given */
    const groups = github(overview());
    const openOnly: ProjectOverview = {
        ...overview(),
        github: {...groups, pullRequests: groups.pullRequests.filter((row) => row.pullRequest.state === 'open')},
    };

    /* When */
    const rows = worktreesView(openOnly, '');

    /* Then */
    assert.equal(rows.find((row) => row.title === 'old-work')?.meta, 'merged · safe to remove');
});

test('Start session is offered on a worktree with no session running that is not merged', () => {
    /* When */
    const rows = worktreesView(overview(), '');

    /* Then */
    assert.deepEqual(
        rows.map((row) => [row.title, row.running, row.startable]),
        [
            ['main', false, true],
            ['fix/redirect', true, false],
            ['rate-limiter', false, true],
            ['old-work', false, false],
            ['detached', false, true],
        ],
    );
});

test('the filter finds a worktree by branch or folder', () => {
    /* When */
    const rows = worktreesView(overview(), 'limiter');

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.title),
        ['rate-limiter'],
    );
});

// ── The cursor and the keys ──

test('the cursor walks pull requests, then plans, then sessions, then worktrees, as the page shows them', () => {
    /* Given */
    const o = overview();
    const plans = planRows(
        plansView(github(o), {expandedPlans: [], showClosed: false, filter: '', looseExpanded: false}),
    );

    /* When */
    const rows = pageRows({
        plans,
        pullRequests: pullRequestRows(pullRequestsView(github(o), o.worktrees, SHOWN)),
        sessions: [{kind: 'session', id: cursorId.session('s1'), sessionId: 's1'}],
        worktrees: worktreeRows(worktreesView(o, '')).slice(0, 2),
    });

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.id),
        [
            'pr:acme/app#21',
            'pr:acme/app#22',
            'pr:acme/app#20',
            'plan:acme/app#10',
            'session:s1',
            'worktree:' + APP,
            'worktree:' + APP + '/.claude/worktrees/redirect',
        ],
    );
});

test('↵ on a pull request opens it on GitHub; on a worktree it does nothing', () => {
    /* Given */
    const o = overview();
    const rows = pageRows({
        plans: [],
        sessions: [],
        pullRequests: pullRequestRows(pullRequestsView(github(o), o.worktrees, SHOWN)),
        worktrees: worktreeRows(worktreesView(o, '')),
    });

    /* When */
    const onPr = pageKeyAction('Enter', rows, 'pr:acme/app#21');
    const onWorktree = pageKeyAction('Enter', rows, 'worktree:' + APP);

    /* Then */
    assert.deepEqual(onPr, {kind: 'open-pull-request', pullRequest: {repository: REPO, number: 21}});
    assert.equal(onWorktree, null);
});

test('S starts a session in a worktree with none running, and does nothing on a busy or merged one, or a PR', () => {
    /* Given */
    const o = overview();
    const rows = pageRows({
        plans: [],
        sessions: [],
        pullRequests: pullRequestRows(pullRequestsView(github(o), o.worktrees, SHOWN)),
        worktrees: worktreeRows(worktreesView(o, '')),
    });
    const limiter = APP + '/.claude/worktrees/limiter';

    /* When */
    const startable = pageKeyAction('S', rows, 'worktree:' + limiter);
    const lower = pageKeyAction('s', rows, 'worktree:' + limiter);
    const busy = pageKeyAction('S', rows, 'worktree:' + APP + '/.claude/worktrees/redirect');
    const merged = pageKeyAction('S', rows, 'worktree:' + APP + '/.claude/worktrees/old');
    const onPr = pageKeyAction('S', rows, 'pr:acme/app#20');

    /* Then */
    assert.deepEqual(startable, {kind: 'start-worktree', path: limiter});
    assert.deepEqual(lower, startable);
    assert.deepEqual([busy, merged, onPr], [null, null, null]);
});

// ── The edge states ──

test('with no answer yet the page is loading, and the worktrees wait for it too', () => {
    /* When */
    const part = githubPart(null, APP);
    const other = githubPart(overview({projectPath: '/dev/other'}), APP);

    /* Then */
    assert.deepEqual(part, {kind: 'loading'});
    assert.deepEqual(other, {kind: 'loading'});
    assert.equal(showsWorktrees(null, APP), true);
});

test('gh missing, signed out or GitHub unreachable with nothing read before: one message, why', () => {
    /* When */
    const parts = (['no-gh', 'signed-out', 'unreachable'] as const).map((reason) =>
        githubPart(overview({github: {ok: false, reason}}), APP),
    );

    /* Then */
    assert.deepEqual(parts, [
        {kind: 'unavailable', reason: 'no-gh'},
        {kind: 'unavailable', reason: 'signed-out'},
        {kind: 'unavailable', reason: 'unreachable'},
    ]);
});

test('the message names gh auth login when gh is missing or signed out, and no command when GitHub is unreachable', () => {
    /* When */
    const signedOut = unavailableMessage('signed-out');
    const missing = unavailableMessage('no-gh');
    const unreachable = unavailableMessage('unreachable');

    /* Then */
    assert.equal(signedOut.title, 'Plans, issues and pull requests come from the GitHub CLI');
    assert.equal(
        signedOut.before + signedOut.command + signedOut.after,
        'Run gh auth login in a terminal, then try again.',
    );
    assert.equal(missing.command, AUTH_COMMAND);
    assert.match(missing.before, /Install the GitHub CLI/);
    assert.equal(unreachable.command, null);
});

test('no GitHub remote: no GitHub part, and the worktrees still show when there are checkouts', () => {
    /* Given */
    const local = overview({repository: null, github: null});
    const notGit = overview({repository: null, github: null, worktrees: []});

    /* When */
    const part = githubPart(local, APP);

    /* Then */
    assert.deepEqual(part, {kind: 'none'});
    assert.equal(showsWorktrees(local, APP), true);
    assert.equal(showsWorktrees(notGit, APP), false);
});

test('an agentless ssh project is remote at once, names its host, and shows no worktrees', () => {
    /* Given */
    const path = 'ssh://joris@build.movelab/srv/deploy';

    /* When */
    const part = githubPart(null, path);

    /* Then */
    assert.deepEqual(part, {kind: 'remote', host: 'joris@build.movelab:22'});
    assert.equal(remoteHost('ssh://ci@runner:2222'), 'ci@runner:2222');
    assert.equal(showsWorktrees(null, path), false);
});

test('an answer kept after a failed refresh is stale, as of when it was read', () => {
    /* Given */
    const stale = overview();
    const groups = github(stale);

    /* When */
    const part = githubPart({...stale, github: {...groups, stale: true, fetchedAt: 1_000}}, APP);

    /* Then */
    assert.deepEqual(part, {kind: 'ok', stale: true, fetchedAt: 1_000});
});

test('the stale line says how old the data is, in words', () => {
    /* When */
    const line = staleLine(0, 6 * 60_000 + 5_000);

    /* Then */
    assert.equal(line, 'Couldn’t reach GitHub. Showing what it said 6 minutes ago.');
    assert.deepEqual(
        [ageInWords(10_000), ageInWords(60_000), ageInWords(2 * 3_600_000), ageInWords(26 * 3_600_000)],
        ['just now', '1 minute ago', '2 hours ago', '1 day ago'],
    );
});

test('nothing open: the sections answer no rows, for one quiet line each', () => {
    /* Given */
    const empty = groupOverview<ProjectIssue, ProjectPullRequest>({
        repository: REPO,
        plans: [],
        issues: [],
        pullRequests: [],
        sessions: {owners: {}, running: new Set()},
    });

    /* When */
    const prs = pullRequestsView(empty, [], SHOWN);
    const plans = plansView(empty, {expandedPlans: [], showClosed: false, filter: '', looseExpanded: false});

    /* Then */
    assert.deepEqual(prs, []);
    assert.deepEqual([plans.plans.length, plans.loose.length], [0, 0]);
});
