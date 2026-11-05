/**
 * The project page's Merge queue section (#315): its state in the
 * project-page slice (the errands, the buttons at work), what it says
 * (`merge-queue-view`), its cursor rows and keys, the session that owns the
 * head, and what its buttons do against a fake `window.api` and fake effects.
 *
 * The queue itself is the domain's (test/merge-queue.test.ts); the section in
 * the real app, with a stubbed overview, is in e2e/tests/project-page.spec.ts.
 */
import {beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {dispatch, getState} from '../src/renderer/state/app-store';
import {NO_MEMORY, queueActionKey} from '../src/renderer/state/project-page-slice';
import {cursorId, mergeQueueRows, pageRows} from '../src/renderer/ui/project-page/page-rows';
import {pageKeyAction} from '../src/renderer/ui/project-page/page-keys';
import {
    countsText,
    estimateText,
    failureLabel,
    fixStatus,
    headSteps,
    heldForReview,
    isEmptyQueue,
    mergeQueueOf,
    nudgePullRequest,
    nudgeStatus,
    reviewerOf,
} from '../src/renderer/ui/project-page/merge-queue-view';
import {
    fixInSession,
    followQueueErrands,
    nudgeConfirm,
    nudgeReviewer,
    optInToQueue,
    retryQueueEntry,
    setMergeQueueEffects,
} from '../src/renderer/ui/project-page/merge-queue-actions';
import {pullRequestSession} from '../src/renderer/ui/project-page/project-sessions';
import {mergeQueue, type MergeQueue, type QueuePullRequest} from '../src/domain/project/merge-queue';
import {nudgeMessage, type QueueErrandView} from '../src/domain/project/queue-errands';
import type {ProjectOverview} from '../src/domain/project/overview';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {Project} from '../src/domain/project/project';
import type {SessionRow} from '../src/domain/session/session';

const REPO = 'acme/app';
const APP = '/dev/app';
const MIN = 60_000;
const NOW = 1_800_000_000_000;

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(projectPath = APP): RendererState {
    return run(initialRendererState(), {type: 'projectPageRestored', projectPath, memory: NO_MEMORY});
}

function pr(number: number, title: string, fields: Partial<QueuePullRequest> = {}): QueuePullRequest {
    return {
        number,
        title,
        url: `https://github.com/${REPO}/pull/${number}`,
        headRef: 'branch-' + number,
        baseRef: 'main',
        draft: false,
        labels: [],
        automerge: null,
        review: 'approved',
        requestedReviewers: [],
        approvedBy: ['ana'],
        checks: [],
        ...fields,
    };
}

const pending = (description: string) => ({state: 'pending' as const, description});

/** A head running its checks, one queued behind it, one held for @sam, and one failed. */
function queue(): MergeQueue {
    return mergeQueue({
        trunk: 'main',
        pullRequests: [
            pr(1, 'The head', {
                labels: ['automerge:opt-in'],
                automerge: pending('First in the merge queue; merges once CI passes'),
                checks: [
                    {name: 'Lint', state: 'passed', startedAt: NOW - 10 * MIN},
                    {name: 'Tests', state: 'running', startedAt: NOW - 10 * MIN},
                ],
            }),
            pr(2, 'Second', {labels: ['automerge:opt-in'], automerge: pending('Number 2 in the merge queue')}),
            pr(3, 'Held', {
                labels: ['automerge:opt-in'],
                review: 'review_required',
                approvedBy: [],
                automerge: pending('Waits for a review by @sam'),
            }),
            pr(4, 'Broken', {
                headRef: 'broken',
                labels: ['automerge:opt-in', 'automerge:failed'],
                automerge: {state: 'failure', description: 'CI failed: a test'},
                checks: [{name: 'Unit tests', state: 'failed', startedAt: NOW - 20 * MIN}],
            }),
            pr(5, 'Approved, not queued'),
        ],
        ciRunDurationsMs: [20 * MIN, 24 * MIN, 30 * MIN],
        now: NOW,
    });
}

function overview(mergeQueue: MergeQueue | null): ProjectOverview {
    return {
        projectPath: APP,
        remote: false,
        repository: REPO,
        github: {
            ok: true,
            fetchedAt: 0,
            stale: false,
            plansPending: false,
            mergeQueue,
            plans: [],
            loose: [],
            pullRequests: [],
        },
        worktrees: [],
        running: [],
    };
}

function answered(o: ProjectOverview, plans = true): RendererEvent {
    return {type: 'projectOverviewAnswered', projectPath: APP, closed: false, merged: false, plans, overview: o};
}

function errand(fields: Partial<QueueErrandView>): QueueErrandView {
    return {
        id: 'e1',
        kind: 'nudge',
        repository: REPO,
        number: 3,
        title: 'Held',
        url: `https://github.com/${REPO}/pull/3`,
        reviewer: 'sam',
        message: 'Hey sam',
        sessionId: 's-errand',
        createdAt: NOW,
        settledAt: null,
        state: 'running',
        ...fields,
    };
}

// ── The slice ──

test('the errands main answers are kept for the repository, and kept when the same page opens again', () => {
    /* Given */
    const errands = [errand({})];

    /* When */
    const state = run(
        opened(),
        {type: 'projectQueueErrandsAnswered', repository: REPO, errands},
        {type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY},
    );

    /* Then */
    assert.deepEqual(state.projectPage.queueErrands, {repository: REPO, errands});
});

test('another project’s page forgets the errands and every button’s state', () => {
    /* Given */
    const state = run(
        opened(),
        {type: 'projectQueueErrandsAnswered', repository: REPO, errands: [errand({})]},
        {type: 'projectQueueActionAsked', key: 'retry:4'},
    );

    /* When */
    const next = run(state, {type: 'projectPageRestored', projectPath: '/dev/other', memory: NO_MEMORY});

    /* Then */
    assert.equal(next.projectPage.queueErrands, null);
    assert.deepEqual(next.projectPage.queueActions, {});
});

test('a button is busy once pressed, and forgets it when its job is done', () => {
    /* Given */
    const asked = run(opened(), {type: 'projectQueueActionAsked', key: 'retry:4'});

    /* When */
    const done = run(asked, {type: 'projectQueueActionAnswered', key: 'retry:4', outcome: {phase: 'done'}});

    /* Then */
    assert.deepEqual(asked.projectPage.queueActions, {'retry:4': {phase: 'busy'}});
    assert.deepEqual(done.projectPage.queueActions, {});
});

test('a button that failed keeps why, and one handed to a running session keeps which', () => {
    /* Given */
    const state = run(
        opened(),
        {type: 'projectQueueActionAsked', key: 'retry:4'},
        {type: 'projectQueueActionAsked', key: 'fix:4'},
    );

    /* When */
    const next = run(
        state,
        {type: 'projectQueueActionAnswered', key: 'retry:4', outcome: {phase: 'failed', reason: 'gh said no'}},
        {type: 'projectQueueActionAnswered', key: 'fix:4', outcome: {phase: 'sent', sessionId: 's1'}},
    );

    /* Then */
    assert.deepEqual(next.projectPage.queueActions, {
        'retry:4': {phase: 'failed', reason: 'gh said no'},
        'fix:4': {phase: 'sent', sessionId: 's1'},
    });
});

test('an answer for a button that was never pressed here is dropped', () => {
    /* Given */
    const state = opened();

    /* When */
    const next = run(state, {
        type: 'projectQueueActionAnswered',
        key: 'retry:4',
        outcome: {phase: 'failed', reason: 'x'},
    });

    /* Then */
    assert.equal(next.projectPage, state.projectPage);
});

test('an answer without plans brings the fresh merge queue over the stored one', () => {
    /* Given */
    const fresh = queue();
    const state = run(initialRendererState(), {
        type: 'projectPageRestored',
        projectPath: APP,
        memory: NO_MEMORY,
        stored: {overview: overview(null), closed: false, merged: false},
    });

    /* When */
    const next = run(state, answered(overview(fresh), false));

    /* Then */
    assert.equal(mergeQueueOf(next.projectPage, APP), fresh);
});

test('the key of a button names its job, its PR and, for a nudge, its reviewer', () => {
    /* When */
    const keys = [queueActionKey('nudge', 3, 'sam'), queueActionKey('fix', 4), queueActionKey('opt-in', 5)];

    /* Then */
    assert.deepEqual(keys, ['nudge:3:sam', 'fix:4', 'opt-in:5']);
});

// ── What the section says ──

test('the queue shows only for the project its overview is for, and only when it has one', () => {
    /* Given */
    const withQueue = run(opened(), answered(overview(queue())));
    const without = run(opened(), answered(overview(null)));

    /* Then */
    assert.ok(mergeQueueOf(withQueue.projectPage, APP));
    assert.equal(mergeQueueOf(withQueue.projectPage, '/dev/other'), null);
    assert.equal(mergeQueueOf(without.projectPage, APP), null);
});

test('estimates read in whole minutes, never under one', () => {
    /* When */
    const texts = [estimateText(6.4 * MIN), estimateText(10_000), estimateText(null)];

    /* Then */
    assert.deepEqual(texts, ['~6 min', '~1 min', null]);
});

test('the heading counts what is queued, held and failed, leaving out what is none', () => {
    /* When */
    const texts = [
        countsText({queued: 4, held: 1, failed: 1}),
        countsText({queued: 2, held: 0, failed: 0}),
        countsText({queued: 0, held: 0, failed: 0}),
    ];

    /* Then */
    assert.deepEqual(texts, ['4 queued · 1 held · 1 failed', '2 queued', '']);
});

test('the fixture queue: a head 14 min from merging, the queue clear in 38', () => {
    /* When */
    const q = queue();

    /* Then */
    assert.equal(estimateText(q.head!.estimateMs), '~14 min');
    assert.equal(estimateText(q.clearsInMs), '~38 min');
    assert.equal(countsText(q.counts), '2 queued · 1 held · 1 failed');
});

test('a queue with nothing in it is empty, even with PRs not queued yet', () => {
    /* Given */
    const empty = mergeQueue({trunk: 'main', pullRequests: [pr(5, 'Approved')], ciRunDurationsMs: [], now: NOW});

    /* Then */
    assert.equal(isEmptyQueue(empty), true);
    assert.equal(empty.outside.length, 1);
    assert.equal(isEmptyQueue(queue()), false);
});

test('the head’s steps while it rebases: the first is under way', () => {
    /* When */
    const steps = headSteps({kind: 'rebasing'});

    /* Then */
    assert.deepEqual(
        steps.map((step) => [step.label, step.state]),
        [
            ['Rebased on the trunk', 'active'],
            ['Pushed', 'todo'],
            ['Checks', 'todo'],
            ['Merge', 'todo'],
        ],
    );
});

test('the head’s steps while its checks run: rebased and pushed, checks done of total with the one running', () => {
    /* When */
    const steps = headSteps({kind: 'checks', done: 3, total: 5, running: 'Instrumented tests', waitsForCiOn: null});

    /* Then */
    assert.deepEqual(
        steps.map((step) => step.state),
        ['done', 'done', 'active', 'todo'],
    );
    assert.equal(steps[2].label, 'Checks 3 of 5');
    assert.equal(steps[2].detail, 'Instrumented tests');
    assert.equal(steps[2].progress, 0.6);
});

test('a stack’s head waiting for CI on a member below says so when no check runs', () => {
    /* When */
    const steps = headSteps({kind: 'checks', done: 1, total: 4, running: null, waitsForCiOn: 41});

    /* Then */
    assert.equal(steps[2].detail, 'waits for CI on #41');
});

test('the head’s steps while it merges: the last is under way', () => {
    /* When */
    const steps = headSteps({kind: 'merging'});

    /* Then */
    assert.deepEqual(
        steps.map((step) => step.state),
        ['done', 'done', 'done', 'active'],
    );
});

test('a failure’s kind in a few words', () => {
    /* When */
    const labels = (
        ['ci', 'conflict', 'changes-requested', 'unresolved-thread', 'merge-refused', 'other'] as const
    ).map(failureLabel);

    /* Then */
    assert.deepEqual(labels, [
        'CI failed',
        'Conflicts with the trunk',
        'Changes requested',
        'Unresolved thread',
        'Merge refused',
        'Failed',
    ]);
});

test('the held entries waiting for a review are what main settles the nudges against', () => {
    /* When */
    const held = heldForReview(queue());

    /* Then */
    assert.deepEqual(held, [{number: 3, reviewer: 'sam'}]);
});

test('a stack held on a member is nudged, and settled, about that member', () => {
    /* Given */
    const q = mergeQueue({
        trunk: 'main',
        pullRequests: [
            pr(10, 'Bottom', {headRef: 'a', labels: ['bot: merges with stack'], review: 'review_required'}),
            pr(12, 'Top', {
                headRef: 'c',
                baseRef: 'a',
                labels: ['automerge:opt-in'],
                automerge: pending('#10: Waits for a review by @sam'),
            }),
        ],
        ciRunDurationsMs: [],
        now: NOW,
    });

    /* When */
    const nudged = nudgePullRequest(q.entries[0]);
    const held = heldForReview(q);

    /* Then */
    assert.deepEqual(nudged, {number: 10, title: 'Bottom', url: `https://github.com/${REPO}/pull/10`});
    assert.deepEqual(held, [{number: 10, reviewer: 'sam'}]);
});

test('a held entry waiting on a team offers no Nudge, and is left out of the settle', () => {
    /* Given */
    const q = mergeQueue({
        trunk: 'main',
        pullRequests: [
            pr(7, 'Team review', {
                labels: ['automerge:opt-in'],
                review: 'review_required',
                automerge: pending('Waits for a review by @acme/web-team'),
            }),
        ],
        ciRunDurationsMs: [],
        now: NOW,
    });

    /* When */
    const reviewer = reviewerOf(q.entries[0]);
    const held = heldForReview(q);

    /* Then */
    assert.equal(reviewer, null);
    assert.deepEqual(held, []);
    assert.match(q.entries[0].sentence, /until @acme\/web-team reviews/);
});

test('a nudge’s state: none, at work, needing you, then sent until its request changes', () => {
    /* When */
    const states = [
        nudgeStatus([], 3, 'sam'),
        nudgeStatus([errand({state: 'starting', sessionId: null})], 3, 'sam'),
        nudgeStatus([errand({state: 'needs-you'})], 3, 'sam'),
        nudgeStatus([errand({state: 'done'})], 3, 'sam'),
        nudgeStatus([errand({state: 'done', settledAt: NOW + MIN})], 3, 'sam'),
        nudgeStatus([errand({state: 'done'})], 3, 'anna'),
    ];

    /* Then */
    assert.deepEqual(states, [
        {kind: 'none'},
        {kind: 'running', sessionId: null},
        {kind: 'needs-you', sessionId: 's-errand'},
        {kind: 'nudged', at: NOW},
        {kind: 'none'},
        {kind: 'none'},
    ]);
});

test('a fix’s state follows its latest errand on any of the entry’s PRs, and is none once it is done', () => {
    /* Given */
    const fix = (fields: Partial<QueueErrandView>) => errand({kind: 'fix', reviewer: null, message: null, ...fields});

    /* When */
    const states = [
        fixStatus([fix({number: 41, state: 'running'})], [40, 41, 42]),
        fixStatus([fix({number: 41, state: 'running'}), fix({id: 'e2', number: 41, state: 'needs-you'})], [41]),
        fixStatus([fix({number: 41, state: 'done'})], [41]),
        fixStatus([errand({number: 41})], [41]),
    ];

    /* Then */
    assert.deepEqual(states, [
        {kind: 'running', sessionId: 's-errand'},
        {kind: 'needs-you', sessionId: 's-errand'},
        {kind: 'none'},
        {kind: 'none'},
    ]);
});

// ── Cursor rows and keys ──

test('the queue’s rows: the head, the entries behind it, then the failed, each its own cursor id', () => {
    /* When */
    const rows = mergeQueueRows(REPO, queue());

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.id),
        ['queue:acme/app#1', 'queue:acme/app#2', 'queue:acme/app#3', 'queue:acme/app#4'],
    );
});

test('the queue’s rows come first on the page, over Pull requests', () => {
    /* Given */
    const queueRows = mergeQueueRows(REPO, queue());
    const prRow = {
        kind: 'pull-request',
        id: cursorId.pullRequest({repository: REPO, number: 9}),
        pullRequest: {repository: REPO, number: 9},
    } as const;

    /* When */
    const rows = pageRows({mergeQueue: queueRows, pullRequests: [prRow], plans: [], sessions: []});

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.id),
        [...queueRows.map((row) => row.id), prRow.id],
    );
});

test('↵ on a queue row opens its PR on GitHub, and ↓ walks from the head to the next entry', () => {
    /* Given */
    const rows = mergeQueueRows(REPO, queue());

    /* When */
    const enter = pageKeyAction('Enter', rows, 'queue:acme/app#2');
    const down = pageKeyAction('ArrowDown', rows, 'queue:acme/app#1');

    /* Then */
    assert.deepEqual(enter, {kind: 'open-pull-request', pullRequest: {repository: REPO, number: 2}});
    assert.deepEqual(down, {kind: 'cursor', target: 'queue:acme/app#2'});
});

// ── The head's owner ──

function session(sessionId: string, modified: string, fields: Partial<SessionRow> = {}): SessionRow {
    return {
        sessionId,
        summary: sessionId,
        firstPrompt: sessionId,
        projectPath: APP,
        created: modified,
        modified,
        messageCount: 1,
        name: null,
        starred: 0,
        archived: 0,
        ...fields,
    };
}

test('the head’s session is the newest unarchived one of the repository that linked one of its PRs', () => {
    /* Given */
    const link = (number: number, repository = REPO) => ({number, repository, url: 'https://x/' + number});
    const projects: Project[] = [
        {
            projectPath: APP,
            folder: 'app',
            remote: false,
            sessions: [
                session('old', '2026-10-01T00:00:00Z', {pullRequests: [link(1)]}),
                session('archived', '2026-10-05T00:00:00Z', {pullRequests: [link(1)], archived: 1}),
                session('other-repo', '2026-10-06T00:00:00Z', {pullRequests: [link(1, 'else/where')]}),
            ],
        },
        {
            projectPath: APP + '/.claude/worktrees/fix',
            folder: 'fix',
            remote: false,
            sessions: [session('newest', '2026-10-04T00:00:00Z', {pullRequests: [link(41)]})],
        },
        {
            projectPath: '/dev/elsewhere',
            folder: 'elsewhere',
            remote: false,
            sessions: [session('outside', '2026-10-09T00:00:00Z', {pullRequests: [link(1)]})],
        },
    ];

    /* When */
    const owner = pullRequestSession(projects, APP, REPO, [40, 41, 1]);
    const none = pullRequestSession(projects, APP, REPO, [99]);

    /* Then */
    assert.equal(owner?.sessionId, 'newest');
    assert.equal(none, null);
});

// ── The buttons ──

/** A main that answers each call by its method's handler, recording every call. */
function installMain(handlers: Record<string, (...args: any[]) => unknown>): {calls: [string, ...unknown[]][]} {
    const calls: [string, ...unknown[]][] = [];
    const api = new Proxy(
        {},
        {
            get:
                (_target, method: string) =>
                async (...args: unknown[]) => {
                    calls.push([method, ...args]);
                    const handler = handlers[method];
                    return handler ? handler(...args) : undefined;
                },
        },
    );
    Object.assign(globalThis, {window: {api}});
    return {calls};
}

/** Effects that record what the section asked of the rest of the renderer. */
function installEffects({yes = true, launched = {ok: true, sessionId: 'new-session'} as const} = {}) {
    const seen = {
        confirms: [] as string[],
        launches: [] as [string, string, string][],
        pulsed: [] as string[],
        reloads: 0,
    };
    setMergeQueueEffects({
        confirm: (message) => {
            seen.confirms.push(message);
            return yes;
        },
        launch: async (directory, projectPath, prompt) => {
            seen.launches.push([directory, projectPath, prompt]);
            return launched as {ok: true; sessionId: string} | {ok: false; reason: string};
        },
        pulse: (id) => seen.pulsed.push(id),
        reload: () => seen.reloads++,
    });
    return seen;
}

const HELD = {number: 3, title: 'Held', url: `https://github.com/${REPO}/pull/3`};

beforeEach(() => {
    dispatch({type: 'projectPageRestored', projectPath: '/dev/reset', memory: NO_MEMORY});
    dispatch({type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY});
    installMain({});
    installEffects();
});

test('Nudge asks first with the exact message, and sends nothing on no', async () => {
    /* Given */
    const main = installMain({});
    const seen = installEffects({yes: false});

    /* When */
    await nudgeReviewer(APP, REPO, HELD, 'sam');

    /* Then */
    assert.deepEqual(seen.confirms, [nudgeConfirm('sam', nudgeMessage(HELD, 'sam'))]);
    assert.ok(seen.confirms[0].includes(nudgeMessage(HELD, 'sam')));
    assert.deepEqual(main.calls, []);
});

test('Nudge on yes records the nudge, starts its session in the project with the prompt, and says which one', async () => {
    /* Given */
    const main = installMain({
        queueNudge: () => ({ok: true, errandId: 'errand-1', prompt: 'Send a Slack message'}),
        queueErrands: () => [errand({id: 'errand-1'})],
    });
    const seen = installEffects();

    /* When */
    await nudgeReviewer(APP, REPO, HELD, 'sam');

    /* Then */
    assert.deepEqual(main.calls.slice(0, 2), [
        ['queueNudge', {repository: REPO, pr: HELD, reviewer: 'sam', message: nudgeMessage(HELD, 'sam')}],
        ['queueErrandStarted', 'errand-1', 'new-session'],
    ]);
    assert.deepEqual(seen.launches, [[APP, APP, 'Send a Slack message']]);
    assert.deepEqual(seen.pulsed, ['new-session']);
    assert.deepEqual(getState().projectPage.queueActions, {});
    assert.equal(getState().projectPage.queueErrands?.errands[0].id, 'errand-1');
});

test('a nudge whose session does not start is abandoned, and the row says why', async () => {
    /* Given */
    const main = installMain({queueNudge: () => ({ok: true, errandId: 'errand-1', prompt: 'p'})});
    installEffects({launched: {ok: false, reason: 'claude is not installed'} as never});

    /* When */
    await nudgeReviewer(APP, REPO, HELD, 'sam');

    /* Then */
    assert.ok(main.calls.some(([method, id]) => method === 'queueErrandAbandoned' && id === 'errand-1'));
    assert.deepEqual(getState().projectPage.queueActions, {
        'nudge:3:sam': {phase: 'failed', reason: 'claude is not installed'},
    });
});

test('a nudge main refuses starts nothing, and the row says why', async () => {
    /* Given */
    installMain({queueNudge: () => ({ok: false, reason: 'sam was nudged already'})});
    const seen = installEffects();

    /* When */
    await nudgeReviewer(APP, REPO, HELD, 'sam');

    /* Then */
    assert.deepEqual(seen.launches, []);
    assert.deepEqual(getState().projectPage.queueActions['nudge:3:sam'], {
        phase: 'failed',
        reason: 'sam was nudged already',
    });
});

test('Fix in session handed to the PR’s own running session says which, and starts nothing', async () => {
    /* Given */
    const failed = queue().failed[0];
    const main = installMain({queueFix: () => ({ok: true, kind: 'queued', sessionId: 'own', activityId: 'a1'})});
    const seen = installEffects();

    /* When */
    await fixInSession(APP, REPO, failed);

    /* Then */
    assert.deepEqual(main.calls[0], [
        'queueFix',
        {
            repository: REPO,
            projectPath: APP,
            pr: {number: 4, title: 'Broken', url: `https://github.com/${REPO}/pull/4`, headRef: 'broken'},
            failure: {kind: 'ci', reason: 'CI failed: a test', checkName: 'Unit tests'},
        },
    ]);
    assert.deepEqual(seen.launches, []);
    assert.deepEqual(getState().projectPage.queueActions['fix:4'], {phase: 'sent', sessionId: 'own'});
});

test('Fix in session with no session of the PR running starts one in the worktree main prepared', async () => {
    /* Given */
    const failed = queue().failed[0];
    const main = installMain({
        queueFix: () => ({
            ok: true,
            kind: 'start',
            errandId: 'fix-1',
            worktreePath: APP + '/.claude/worktrees/broken',
            branch: 'broken',
            prompt: 'Fix it',
        }),
    });
    const seen = installEffects();

    /* When */
    await fixInSession(APP, REPO, failed);

    /* Then */
    assert.deepEqual(seen.launches, [[APP + '/.claude/worktrees/broken', APP, 'Fix it']]);
    assert.ok(main.calls.some(([method, ...args]) => method === 'queueErrandStarted' && args[0] === 'fix-1'));
    assert.deepEqual(getState().projectPage.queueActions, {});
    assert.equal(seen.reloads, 1);
});

test('Retry removes the failed label through main, then asks for the overview again', async () => {
    /* Given */
    const main = installMain({queueRetry: () => ({ok: true})});
    const seen = installEffects();

    /* When */
    await retryQueueEntry(REPO, 4);

    /* Then */
    assert.deepEqual(main.calls, [['queueRetry', REPO, 4]]);
    assert.equal(seen.reloads, 1);
    assert.deepEqual(getState().projectPage.queueActions, {});
});

test('an Opt in GitHub refuses keeps why on its button, and the overview is not asked again', async () => {
    /* Given */
    installMain({queueOptIn: () => ({ok: false, reason: 'gh: not allowed'})});
    const seen = installEffects();

    /* When */
    await optInToQueue(REPO, 5);

    /* Then */
    assert.deepEqual(getState().projectPage.queueActions['opt-in:5'], {phase: 'failed', reason: 'gh: not allowed'});
    assert.equal(seen.reloads, 0);
});

test('the errands are read after main is told which held entries wait for a review now', async () => {
    /* Given */
    const errands = [errand({})];
    const main = installMain({queueErrands: () => errands});

    /* When */
    await followQueueErrands(REPO, queue());

    /* Then */
    assert.deepEqual(main.calls, [
        ['queueSettleNudges', REPO, [{number: 3, reviewer: 'sam'}]],
        ['queueErrands', REPO],
    ]);
    assert.deepEqual(getState().projectPage.queueErrands, {repository: REPO, errands});
});
