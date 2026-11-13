import {test} from 'node:test';
import assert from 'node:assert/strict';

import {GhCli, type GhResult, type GhRunner} from '../src/infrastructure/github/gh-cli';
import {toCiRunDurations, toQueueCheckRun} from '../src/infrastructure/github/gh-overview';

/** A runner that answers from a script and records what it was asked. */
function scripted(answer: (args: readonly string[]) => Partial<GhResult>): GhRunner & {calls: string[][]} {
    const calls: string[][] = [];
    const run = (async (args: readonly string[]) => {
        calls.push([...args]);
        return {missing: false, code: 0, stdout: '', stderr: '', ...answer(args)};
    }) as GhRunner & {calls: string[][]};
    run.calls = calls;
    return run;
}

const answering = (body: unknown) => scripted(() => ({stdout: JSON.stringify(body)}));
const missing = (): Partial<GhResult> => ({missing: true, code: null});
const signedOut = (): Partial<GhResult> => ({
    code: 4,
    stderr: 'To get started with GitHub CLI, please run:  gh auth login\n',
});
const unreachable = (): Partial<GhResult> => ({
    code: 1,
    stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
});

/** What the merge queue reads of a PR whose node carries none of its fields. */
const noQueue = (number: number) => ({
    url: `https://github.com/JBlaak/switchboard/pull/${number}`,
    baseRef: '',
    labels: [],
    automerge: null,
    requestedReviewers: [],
    approvedBy: [],
    checks: [],
});

/** What a PR's group and open point read of a node that carries none of their fields. */
const noWait = () => ({
    closedAt: null,
    failedChecks: [],
    cancelledChecks: [],
    reviewRequestedFromYou: false,
    reviewRequestedFromOthers: false,
    unresolvedThreads: 0,
    mergeable: 'unknown',
    behindBase: null,
});

/** The GraphQL query text of a recorded `gh api graphql` call. */
const queryOf = (args: readonly string[]) => args[args.indexOf('-f') + 1].replace(/^query=/, '');

/** No check failed, so each state counts zero. */
const zeroCounts = (states: string[]) => states.map((state) => ({state, count: 0}));
const CHECK_RUN_STATES = [
    'ACTION_REQUIRED',
    'CANCELLED',
    'COMPLETED',
    'FAILURE',
    'IN_PROGRESS',
    'NEUTRAL',
    'PENDING',
    'QUEUED',
    'SKIPPED',
    'STALE',
    'STARTUP_FAILURE',
    'SUCCESS',
    'TIMED_OUT',
    'WAITING',
];
const STATUS_STATES = ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'];

/** A rollup as GitHub answers it, with `counts` set over zeros for every other state. */
function rollup(state: string, runs: Record<string, number> = {}, statuses: Record<string, number> = {}) {
    return {
        state,
        contexts: {
            checkRunCountsByState: zeroCounts(CHECK_RUN_STATES).map((entry) => ({
                ...entry,
                count: runs[entry.state] ?? 0,
            })),
            statusContextCountsByState: zeroCounts(STATUS_STATES).map((entry) => ({
                ...entry,
                count: statuses[entry.state] ?? 0,
            })),
        },
    };
}

const SWITCHBOARD = {nameWithOwner: 'JBlaak/switchboard'};

/** Recorded from JBlaak/switchboard on 2026-10-22, trimmed to three issues. */
const recordedIssues = {
    data: {
        repository: {
            issues: {
                nodes: [
                    {
                        number: 169,
                        title: "Read a repository's open issues, pull requests and worktrees",
                        state: 'OPEN',
                        updatedAt: '2026-10-22T09:58:52Z',
                        repository: SWITCHBOARD,
                        labels: {nodes: [{name: 'ready-for-agent', color: '8fd8bf'}]},
                        parent: {number: 167, repository: SWITCHBOARD},
                        subIssuesSummary: {total: 0},
                    },
                    {
                        number: 167,
                        title: 'Project page per repository, and a Projects modal in place of New Session',
                        state: 'OPEN',
                        updatedAt: '2026-10-22T09:59:03Z',
                        repository: SWITCHBOARD,
                        labels: {
                            nodes: [
                                {name: 'ready-for-agent', color: '8fd8bf'},
                                {name: 'enhancement', color: 'a2eeef'},
                            ],
                        },
                        parent: null,
                        subIssuesSummary: {total: 10},
                    },
                    {
                        number: 154,
                        title: 'Quick Ask follow-ups',
                        state: 'CLOSED',
                        updatedAt: '2026-10-20T14:02:11Z',
                        repository: SWITCHBOARD,
                        labels: {nodes: []},
                        parent: {number: 142, repository: {nameWithOwner: 'JBlaak/planning'}},
                        subIssuesSummary: {total: 0},
                    },
                ],
            },
        },
    },
};

/** Recorded from JBlaak/switchboard, with checks and reviews set to cover each state. */
const recordedPullRequests = {
    data: {
        repository: {
            pullRequests: {
                nodes: [
                    {
                        number: 166,
                        title: 'Quick Ask: ⌘Enter starts a quick session without routing',
                        state: 'MERGED',
                        isDraft: false,
                        headRefName: 'quick-ask-cmd-enter',
                        updatedAt: '2026-10-22T08:20:16Z',
                        reviewDecision: null,
                        repository: SWITCHBOARD,
                        statusCheckRollup: rollup('SUCCESS', {SKIPPED: 1, SUCCESS: 3}),
                        closingIssuesReferences: {nodes: []},
                    },
                    {
                        number: 180,
                        title: "Read a repository's open issues",
                        state: 'OPEN',
                        isDraft: false,
                        viewerDidAuthor: true,
                        headRefName: 'issue-169-overview-reads',
                        updatedAt: '2026-10-22T11:00:00Z',
                        reviewDecision: 'CHANGES_REQUESTED',
                        repository: SWITCHBOARD,
                        statusCheckRollup: rollup('FAILURE', {FAILURE: 1, TIMED_OUT: 1, SUCCESS: 2}, {ERROR: 1}),
                        closingIssuesReferences: {
                            nodes: [
                                {number: 169, repository: SWITCHBOARD},
                                {number: 12, repository: {nameWithOwner: 'JBlaak/planning'}},
                            ],
                        },
                    },
                    {
                        number: 181,
                        title: "Group a project's issues under their plans",
                        state: 'OPEN',
                        isDraft: true,
                        headRefName: 'issue-170-grouping',
                        updatedAt: '2026-10-22T10:30:00Z',
                        reviewDecision: 'REVIEW_REQUIRED',
                        repository: SWITCHBOARD,
                        statusCheckRollup: rollup('PENDING', {IN_PROGRESS: 1, SUCCESS: 1}),
                        closingIssuesReferences: {nodes: [{number: 170, repository: SWITCHBOARD}]},
                    },
                    {
                        number: 182,
                        title: 'Docs only',
                        state: 'OPEN',
                        isDraft: false,
                        headRefName: 'docs',
                        updatedAt: '2026-10-22T09:00:00Z',
                        reviewDecision: 'APPROVED',
                        repository: SWITCHBOARD,
                        statusCheckRollup: null,
                        closingIssuesReferences: {nodes: []},
                    },
                ],
            },
        },
    },
};

// ── Issues ──

test("a repository's open issues are one GraphQL request, newest first, with labels, parent and sub-issue count", async () => {
    /* Given */
    const run = answering(recordedIssues);

    /* When */
    await new GhCli({run}).issuesIn('JBlaak/switchboard', {closed: false});

    /* Then */
    assert.equal(run.calls.length, 1);
    const query = queryOf(run.calls[0]);
    assert.match(query, /issues\(states: \[OPEN\], first: 100, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/);
    assert.match(query, /labels\(first: 20\) \{ nodes \{ name color \} \}/);
    assert.match(query, /parent \{ number repository \{ nameWithOwner \} \}/);
    assert.match(query, /subIssuesSummary \{ total \}/);
    assert.deepEqual(run.calls[0].slice(-4), ['-f', 'owner=JBlaak', '-f', 'name=switchboard']);
});

test('closed issues are asked for only when wanted', async () => {
    /* Given */
    const run = answering(recordedIssues);

    /* When */
    await new GhCli({run}).issuesIn('JBlaak/switchboard', {closed: true});

    /* Then */
    assert.match(queryOf(run.calls[0]), /issues\(states: \[OPEN, CLOSED\]/);
});

test('a recorded answer maps to issues with their labels, parent and sub-issue count, newest first', async () => {
    /* Given */
    const gh = new GhCli({run: answering(recordedIssues)});

    /* When */
    const issues = await gh.issuesIn('JBlaak/switchboard', {closed: true});

    /* Then */
    assert.deepEqual(issues, [
        {
            repository: 'JBlaak/switchboard',
            number: 167,
            title: 'Project page per repository, and a Projects modal in place of New Session',
            state: 'open',
            labels: [
                {name: 'ready-for-agent', color: '8fd8bf'},
                {name: 'enhancement', color: 'a2eeef'},
            ],
            updatedAt: '2026-10-22T09:59:03Z',
            parent: null,
            subIssues: 10,
        },
        {
            repository: 'JBlaak/switchboard',
            number: 169,
            title: "Read a repository's open issues, pull requests and worktrees",
            state: 'open',
            labels: [{name: 'ready-for-agent', color: '8fd8bf'}],
            updatedAt: '2026-10-22T09:58:52Z',
            parent: {repository: 'JBlaak/switchboard', number: 167},
            subIssues: 0,
        },
        {
            repository: 'JBlaak/switchboard',
            number: 154,
            title: 'Quick Ask follow-ups',
            state: 'closed',
            labels: [],
            updatedAt: '2026-10-20T14:02:11Z',
            parent: {repository: 'JBlaak/planning', number: 142},
            subIssues: 0,
        },
    ]);
});

test('an issue missing fields falls back rather than failing', async () => {
    /* Given */
    const gh = new GhCli({
        run: answering({data: {repository: {issues: {nodes: [{number: 5}, null, {title: 'no number'}]}}}}),
    });

    /* When */
    const issues = await gh.issuesIn('acme/web', {closed: false});

    /* Then */
    assert.deepEqual(issues, [
        {
            repository: 'acme/web',
            number: 5,
            title: '',
            state: 'closed',
            labels: [],
            updatedAt: '',
            parent: null,
            subIssues: 0,
        },
    ]);
});

// ── Pull requests ──

test("a repository's open pull requests are one GraphQL request with checks counted by state", async () => {
    /* Given */
    const run = answering(recordedPullRequests);

    /* When */
    await new GhCli({run}).pullRequestsIn('JBlaak/switchboard', {merged: false});

    /* Then */
    assert.equal(run.calls.length, 1);
    const query = queryOf(run.calls[0]);
    assert.match(
        query,
        /pullRequests\(states: \[OPEN\], first: 50, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/,
    );
    assert.match(query, /reviewDecision/);
    assert.match(query, /checkRunCountsByState \{ state count \}/);
    assert.match(query, /statusContextCountsByState \{ state count \}/);
    assert.match(query, /closingIssuesReferences\(first: 20\)/);
    assert.deepEqual(run.calls[0].slice(-4), ['-f', 'owner=JBlaak', '-f', 'name=switchboard']);
});

test('merged pull requests are asked for only when wanted', async () => {
    /* Given */
    const run = answering(recordedPullRequests);

    /* When */
    await new GhCli({run}).pullRequestsIn('JBlaak/switchboard', {merged: true});

    /* Then */
    assert.match(queryOf(run.calls[0]), /pullRequests\(states: \[OPEN, MERGED\]/);
});

test('a recorded answer maps to pull requests with their checks, review, closing issues and whether you opened them, newest first', async () => {
    /* Given */
    const gh = new GhCli({run: answering(recordedPullRequests)});

    /* When */
    const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: true});

    /* Then */
    assert.deepEqual(prs, [
        {
            repository: 'JBlaak/switchboard',
            number: 180,
            title: "Read a repository's open issues",
            state: 'open',
            draft: false,
            mine: true,
            headRef: 'issue-169-overview-reads',
            updatedAt: '2026-10-22T11:00:00Z',
            checks: {state: 'failing', failing: 3},
            review: 'changes_requested',
            closes: [
                {repository: 'JBlaak/switchboard', number: 169},
                {repository: 'JBlaak/planning', number: 12},
            ],
            wait: noWait(),
            queue: noQueue(180),
        },
        {
            repository: 'JBlaak/switchboard',
            number: 181,
            title: "Group a project's issues under their plans",
            state: 'open',
            draft: true,
            mine: false,
            headRef: 'issue-170-grouping',
            updatedAt: '2026-10-22T10:30:00Z',
            checks: {state: 'running', failing: 0},
            review: 'review_required',
            closes: [{repository: 'JBlaak/switchboard', number: 170}],
            wait: noWait(),
            queue: noQueue(181),
        },
        {
            repository: 'JBlaak/switchboard',
            number: 182,
            title: 'Docs only',
            state: 'open',
            draft: false,
            mine: false,
            headRef: 'docs',
            updatedAt: '2026-10-22T09:00:00Z',
            checks: {state: 'none', failing: 0},
            review: 'approved',
            closes: [],
            wait: noWait(),
            queue: noQueue(182),
        },
        {
            repository: 'JBlaak/switchboard',
            number: 166,
            title: 'Quick Ask: ⌘Enter starts a quick session without routing',
            state: 'merged',
            draft: false,
            mine: false,
            headRef: 'quick-ask-cmd-enter',
            updatedAt: '2026-10-22T08:20:16Z',
            checks: {state: 'passing', failing: 0},
            review: null,
            closes: [],
            wait: noWait(),
            queue: noQueue(166),
        },
    ]);
});

test('one failed check makes the rollup failing while others still run', async () => {
    /* Given */
    const body = structuredClone(recordedPullRequests) as any;
    body.data.repository.pullRequests.nodes[2].statusCheckRollup = rollup('PENDING', {IN_PROGRESS: 2, CANCELLED: 1});
    const gh = new GhCli({run: answering(body)});

    /* When */
    const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: false});

    /* Then */
    assert.deepEqual(prs?.find((pr) => pr.number === 181)?.checks, {state: 'failing', failing: 1});
});

// ── What a PR waits on ──

test('the pull request read asks, in the same request, for who you are, recently closed PRs and what each waits on', async () => {
    /* Given */
    const run = answering(recordedPullRequests);

    /* When */
    await new GhCli({run}).pullRequestsIn('JBlaak/switchboard', {merged: false});

    /* Then */
    assert.equal(run.calls.length, 1);
    const query = queryOf(run.calls[0]);
    assert.match(query, /viewer \{ login \}/);
    assert.match(
        query,
        /recentlyClosed: pullRequests\(states: \[MERGED, CLOSED\], first: 20, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/,
    );
    assert.match(query, /closedAt reviewDecision mergeable mergeStateStatus/);
    assert.match(
        query,
        /reviewThreads\(first: 50\) \{ nodes \{ isResolved comments\(first: 1\) \{ totalCount nodes \{ body \} \} \} \}/,
    );
});

/** A review thread as GitHub answers it: resolved or not, its comment count and its first comment. */
function thread(resolved: boolean, totalCount: number, body: string) {
    return {isResolved: resolved, comments: {totalCount, nodes: [{body}]}};
}

const NOTE = "> 🤖 **Claude Code** · author's note explaining this change — not review feedback\n\nWhy.";

test("a PR's wait reads map from its node: failed checks, reviews asked, unresolved threads, conflict and behind", async () => {
    /* Given */
    const node = {
        ...queueNode(),
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'BEHIND',
        reviewRequests: {nodes: [{requestedReviewer: {login: 'sam'}}, {requestedReviewer: {login: 'JBlaak'}}]},
        statusCheckRollup: {
            ...rollup('FAILURE', {FAILURE: 1, CANCELLED: 1}),
            contexts: {
                ...rollup('FAILURE', {FAILURE: 1, CANCELLED: 1}).contexts,
                nodes: [
                    {name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null},
                    {name: 'e2e', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: null},
                    {name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null},
                ],
            },
        },
        reviewThreads: {
            nodes: [
                thread(false, 1, NOTE),
                thread(false, 2, NOTE),
                thread(false, 1, 'Please rename this.'),
                thread(true, 1, 'Fixed.'),
            ],
        },
    };
    const gh = new GhCli({run: answering({data: {viewer: {login: 'JBlaak'}, ...withNode(node).data}})});

    /* When */
    const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: false});

    /* Then */
    assert.deepEqual(prs?.[0].wait, {
        closedAt: null,
        failedChecks: ['test', 'e2e'],
        cancelledChecks: ['e2e'],
        reviewRequestedFromYou: true,
        reviewRequestedFromOthers: true,
        unresolvedThreads: 2,
        mergeable: 'conflicting',
        behindBase: 'main',
    });
});

test('without a viewer, no review is taken to be asked of you', async () => {
    /* Given */
    const gh = new GhCli({run: answering(withNode(queueNode()))});

    /* When */
    const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: false});

    /* Then */
    assert.equal(prs?.[0].wait.reviewRequestedFromYou, false);
    assert.equal(prs?.[0].wait.reviewRequestedFromOthers, true);
});

test('recently closed PRs are listed with the rest, each once, a closed one as closed with when', async () => {
    /* Given */
    const open = queueNode();
    const merged = {...queueNode(), number: 200, state: 'MERGED', closedAt: '2026-11-01T09:00:00Z'};
    const closed = {
        ...queueNode(),
        number: 201,
        state: 'CLOSED',
        updatedAt: '2026-11-01T11:00:00Z',
        closedAt: '2026-11-01T11:00:00Z',
    };
    const body = {
        data: {repository: {pullRequests: {nodes: [open, merged]}, recentlyClosed: {nodes: [closed, merged]}}},
    };
    const gh = new GhCli({run: answering(body)});

    /* When */
    const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: true});

    /* Then */
    assert.deepEqual(
        prs?.map((pr) => [pr.number, pr.state, pr.wait.closedAt]),
        [
            [201, 'closed', '2026-11-01T11:00:00Z'],
            [210, 'open', null],
            [200, 'merged', '2026-11-01T09:00:00Z'],
        ],
    );
});

// ── What the merge queue reads (#315) ──

/** A PR node as the queue's fields come back, hand-made after GitHub's schema. */
function queueNode() {
    return {
        number: 210,
        title: 'Rate limiter',
        state: 'OPEN',
        isDraft: false,
        headRefName: 'rate-limiter',
        baseRefName: 'main',
        url: 'https://github.com/JBlaak/switchboard/pull/210',
        updatedAt: '2026-11-01T10:00:00Z',
        reviewDecision: 'APPROVED',
        repository: SWITCHBOARD,
        statusCheckRollup: {
            ...rollup('PENDING', {IN_PROGRESS: 1, SUCCESS: 1}, {PENDING: 1}),
            contexts: {
                ...rollup('PENDING', {IN_PROGRESS: 1, SUCCESS: 1}, {PENDING: 1}).contexts,
                nodes: [
                    {name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z'},
                    {name: 'test', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-11-01T10:01:00Z'},
                    {},
                ],
            },
        },
        closingIssuesReferences: {nodes: []},
        labels: {nodes: [{name: 'automerge:opt-in'}, {name: 'bot: first in queue'}]},
        commits: {
            nodes: [
                {
                    commit: {
                        status: {
                            context: {state: 'PENDING', description: 'First in the merge queue; merges once CI passes'},
                        },
                    },
                },
            ],
        },
        reviewRequests: {nodes: [{requestedReviewer: {login: 'sam'}}, {requestedReviewer: {}}]},
        latestReviews: {
            nodes: [
                {state: 'APPROVED', author: {login: 'kim'}},
                {state: 'COMMENTED', author: {login: 'lee'}},
                {state: 'APPROVED', author: {login: 'ana'}},
            ],
        },
    };
}

const withNode = (node: unknown) => ({data: {repository: {pullRequests: {nodes: [node]}}}});

test('the pull request read asks, in the same request, for what the merge queue reads of each PR', async () => {
    /* Given */
    const run = answering(recordedPullRequests);

    /* When */
    await new GhCli({run}).pullRequestsIn('JBlaak/switchboard', {merged: false});

    /* Then */
    assert.equal(run.calls.length, 1);
    const query = queryOf(run.calls[0]);
    assert.match(query, /baseRefName url/);
    assert.match(query, /labels\(first: 20\) \{ nodes \{ name \} \}/);
    assert.match(query, /status \{ context\(name: "automerge"\) \{ state description \} \}/);
    assert.match(
        query,
        /reviewRequests\(first: 20\) \{ nodes \{ requestedReviewer \{ \.\.\. on User \{ login \} \} \} \}/,
    );
    assert.match(query, /latestReviews\(first: 20\) \{ nodes \{ state author \{ login \} \} \}/);
    assert.match(query, /nodes \{ \.\.\. on CheckRun \{ name status conclusion startedAt \} \}/);
    assert.doesNotMatch(query, /Team/);
});

test("a PR's queue reads map from its node: base, labels, the automerge status, reviewers, approvals and check runs", async () => {
    /* Given */
    const gh = new GhCli({run: answering(withNode(queueNode()))});

    /* When */
    const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: false});

    /* Then */
    assert.deepEqual(prs?.[0].queue, {
        url: 'https://github.com/JBlaak/switchboard/pull/210',
        baseRef: 'main',
        labels: ['automerge:opt-in', 'bot: first in queue'],
        automerge: {state: 'pending', description: 'First in the merge queue; merges once CI passes'},
        requestedReviewers: ['sam'],
        approvedBy: ['kim', 'ana'],
        checks: [
            {name: 'lint', state: 'passed', startedAt: Date.parse('2026-11-01T10:00:00Z')},
            {name: 'test', state: 'running', startedAt: Date.parse('2026-11-01T10:01:00Z')},
        ],
    });
    assert.deepEqual(prs?.[0].checks, {state: 'running', failing: 0});
});

for (const [state, expected] of [
    ['SUCCESS', 'success'],
    ['FAILURE', 'failure'],
    ['ERROR', 'error'],
    ['PENDING', 'pending'],
    ['EXPECTED', 'pending'],
] as const) {
    test(`an automerge status of ${state} reads as ${expected}`, async () => {
        /* Given */
        const node = queueNode();
        node.commits.nodes[0].commit.status.context.state = state;
        const gh = new GhCli({run: answering(withNode(node))});

        /* When */
        const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: false});

        /* Then */
        assert.equal(prs?.[0].queue.automerge?.state, expected);
    });
}

test('a head commit without an automerge status reads as none', async () => {
    /* Given */
    const node = {...queueNode(), commits: {nodes: [{commit: {status: null}}]}};
    const gh = new GhCli({run: answering(withNode(node))});

    /* When */
    const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: false});

    /* Then */
    assert.equal(prs?.[0].queue.automerge, null);
});

for (const [status, conclusion, expected] of [
    ['QUEUED', null, 'queued'],
    ['WAITING', null, 'queued'],
    ['PENDING', null, 'queued'],
    ['IN_PROGRESS', null, 'running'],
    ['COMPLETED', 'SUCCESS', 'passed'],
    ['COMPLETED', 'NEUTRAL', 'passed'],
    ['COMPLETED', 'SKIPPED', 'skipped'],
    ['COMPLETED', 'CANCELLED', 'cancelled'],
    ['COMPLETED', 'FAILURE', 'failed'],
    ['COMPLETED', 'TIMED_OUT', 'failed'],
    ['COMPLETED', 'ACTION_REQUIRED', 'failed'],
    ['COMPLETED', 'STARTUP_FAILURE', 'failed'],
] as const) {
    test(`a check run ${status}${conclusion ? ' ' + conclusion : ''} reads as ${expected}`, () => {
        /* Given */
        const check = {name: 'test', status, conclusion, startedAt: '2026-11-01T10:01:00Z'};

        /* When */
        const read = toQueueCheckRun(check);

        /* Then */
        assert.equal(read.state, expected);
        assert.equal(read.startedAt, expected === 'queued' ? null : Date.parse('2026-11-01T10:01:00Z'));
    });
}

// ── CI run durations (#315) ──

/** A green run as `gh run list --json` answers it, lasting `minutes` from its start. */
function greenRun(workflowName: string, minutes: number, event = 'pull_request') {
    const startedAt = '2026-11-01T10:00:00Z';
    return {
        workflowName,
        event,
        createdAt: '2026-11-01T09:59:00Z',
        startedAt,
        updatedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(),
    };
}

test("a repository's CI run durations are one gh run list of its green runs", async () => {
    /* Given */
    const run = scripted(() => ({stdout: JSON.stringify([greenRun('CI', 10)])}));

    /* When */
    await new GhCli({run}).ciRunDurations('JBlaak/switchboard');

    /* Then */
    assert.deepEqual(run.calls, [
        [
            'run',
            'list',
            '--repo',
            'JBlaak/switchboard',
            '--status',
            'success',
            '--limit',
            '100',
            '--json',
            'workflowName,event,createdAt,startedAt,updatedAt',
        ],
    ]);
});

test('the CI workflow is the slowest one run for pull requests, and each run lasts from its start to its last update', () => {
    /* Given */
    const runs = [
        greenRun('Lint', 1),
        greenRun('CI', 10),
        greenRun('Lint', 2),
        greenRun('CI', 12),
        greenRun('Lint', 1),
        greenRun('CI', 11),
        greenRun('Nightly', 90, 'schedule'),
    ];

    /* When */
    const durations = toCiRunDurations(runs);

    /* Then */
    assert.deepEqual(durations, [10 * 60_000, 12 * 60_000, 11 * 60_000]);
});

test('only the latest 20 green runs of the CI workflow count', () => {
    /* Given */
    const runs = Array.from({length: 30}, (_, at) => greenRun('CI', at + 1));

    /* When */
    const durations = toCiRunDurations(runs);

    /* Then */
    assert.equal(durations?.length, 20);
    assert.equal(durations?.[0], 60_000);
    assert.equal(durations?.[19], 20 * 60_000);
});

test('a slow workflow with too few runs for an estimate loses to one that has enough', () => {
    /* Given */
    const runs = [greenRun('Deploy preview', 30), greenRun('CI', 10), greenRun('CI', 10), greenRun('CI', 10)];

    /* When */
    const durations = toCiRunDurations(runs);

    /* Then */
    assert.deepEqual(durations, [10 * 60_000, 10 * 60_000, 10 * 60_000]);
});

test('without pull request runs every workflow counts, and a run without a start time counts from its creation', () => {
    /* Given */
    const run = {...greenRun('CI', 5, 'push'), startedAt: undefined};

    /* When */
    const durations = toCiRunDurations([run]);

    /* Then */
    assert.deepEqual(durations, [6 * 60_000]);
});

test('no green runs answer none, and an answer that is not a list answers null', () => {
    /* Given */
    const empty: unknown[] = [];

    /* When */
    const none = toCiRunDurations(empty);
    const garbled = toCiRunDurations({message: 'Not Found'});

    /* Then */
    assert.deepEqual(none, []);
    assert.equal(garbled, null);
});

for (const [why, result] of [
    ['missing', missing],
    ['signed out', signedOut],
    ['unreachable', unreachable],
] as const) {
    test(`CI run durations answer null when gh is ${why}`, async () => {
        /* Given */
        const gh = new GhCli({run: scripted(result)});

        /* When */
        const durations = await gh.ciRunDurations('JBlaak/switchboard');

        /* Then */
        assert.equal(durations, null);
    });
}

// ── The merge queue's labels (#315) ──

test('adding a label posts it to the PR’s labels', async () => {
    /* Given */
    const run = scripted(() => ({stdout: '[]'}));

    /* When */
    const answer = await new GhCli({run}).addLabel('JBlaak/switchboard', 210, 'automerge:opt-in');

    /* Then */
    assert.deepEqual(answer, {ok: true});
    assert.deepEqual(run.calls, [
        ['api', '--method', 'POST', 'repos/JBlaak/switchboard/issues/210/labels', '-f', 'labels[]=automerge:opt-in'],
    ]);
});

test('removing a label deletes it from the PR, its name escaped in the path', async () => {
    /* Given */
    const run = scripted(() => ({stdout: '[]'}));

    /* When */
    const answer = await new GhCli({run}).removeLabel('JBlaak/switchboard', 210, 'automerge:failed');

    /* Then */
    assert.deepEqual(answer, {ok: true});
    assert.deepEqual(run.calls, [
        ['api', '--method', 'DELETE', 'repos/JBlaak/switchboard/issues/210/labels/automerge%3Afailed'],
    ]);
});

test("a label write GitHub refuses answers GitHub's reason", async () => {
    /* Given */
    const run = scripted(() => ({
        code: 1,
        stdout: JSON.stringify({message: 'Label does not exist', status: '404'}),
        stderr: 'gh: Label does not exist (HTTP 404)\n',
    }));

    /* When */
    const answer = await new GhCli({run}).removeLabel('JBlaak/switchboard', 210, 'automerge:failed');

    /* Then */
    assert.deepEqual(answer, {ok: false, reason: 'Label does not exist'});
});

test('a label write says why when gh is missing or signed out', async () => {
    /* Given */
    const absent = new GhCli({run: scripted(missing)});
    const out = new GhCli({run: scripted(signedOut)});

    /* When */
    const added = await absent.addLabel('JBlaak/switchboard', 210, 'automerge:opt-in');
    const removed = await out.removeLabel('JBlaak/switchboard', 210, 'automerge:failed');

    /* Then */
    assert.deepEqual(added, {ok: false, reason: 'gh is not installed'});
    assert.deepEqual(removed, {ok: false, reason: 'gh is not signed in to github.com'});
});

test('a label write to something that is not a repository and PR is never sent to gh', async () => {
    /* Given */
    const run = scripted(() => ({stdout: '[]'}));
    const gh = new GhCli({run});

    /* When */
    const answers = [
        await gh.addLabel('acme', 210, 'automerge:opt-in'),
        await gh.addLabel('JBlaak/switchboard', 0, 'automerge:opt-in'),
        await gh.removeLabel('JBlaak/switchboard', 210, ''),
    ];

    /* Then */
    assert.ok(answers.every((answer) => !answer.ok));
    assert.equal(run.calls.length, 0);
});

// ── When gh cannot answer ──

for (const [why, result] of [
    ['missing', missing],
    ['signed out', signedOut],
    ['unreachable', unreachable],
] as const) {
    test(`both reads answer null when gh is ${why}, without throwing`, async () => {
        /* Given */
        const gh = new GhCli({run: scripted(result)});

        /* When */
        const issues = await gh.issuesIn('JBlaak/switchboard', {closed: false});
        const prs = await gh.pullRequestsIn('JBlaak/switchboard', {merged: false});

        /* Then */
        assert.equal(issues, null);
        assert.equal(prs, null);
    });
}

test('both reads answer null when GitHub knows no such repository', async () => {
    /* Given */
    const run = scripted(() => ({
        code: 1,
        stdout: JSON.stringify({
            data: {repository: null},
            errors: [{type: 'NOT_FOUND', message: 'Could not resolve to a Repository'}],
        }),
    }));
    const gh = new GhCli({run});

    /* When */
    const issues = await gh.issuesIn('acme/gone', {closed: false});
    const prs = await gh.pullRequestsIn('acme/gone', {merged: false});

    /* Then */
    assert.equal(issues, null);
    assert.equal(prs, null);
});

test('a repository name that is not owner/repo is never sent to gh', async () => {
    /* Given */
    const run = answering(recordedIssues);
    const gh = new GhCli({run});

    /* When */
    const issues = await gh.issuesIn('not a repo', {closed: false});
    const prs = await gh.pullRequestsIn('acme', {merged: false});

    /* Then */
    assert.equal(issues, null);
    assert.equal(prs, null);
    assert.equal(run.calls.length, 0);
});
