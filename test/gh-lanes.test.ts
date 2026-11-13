/**
 * The Merge manager's GitHub reads (#434): the slim lane query and how its
 * answer, the queued-PR search and the workflow tree map onto the lane's
 * reads, from responses shaped as GitHub answers them.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    QUEUED_SEARCH,
    laneQuery,
    toLaneRead,
    toQueuedPullRequests,
    toTrunkRules,
    toWorkflowFiles,
} from '../src/infrastructure/github/gh-lanes';
import {GhCli} from '../src/infrastructure/github/gh-cli';

const PR_NODE = {
    number: 2450,
    title: 'Add equipment categories',
    url: 'https://github.com/MoveLab-Studio/Connect/pull/2450',
    state: 'OPEN',
    isDraft: false,
    mergedAt: null,
    headRefName: '2446-equipment',
    headRefOid: 'e445365',
    baseRefName: 'main',
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'DIRTY',
    author: {login: 'JBlaak'},
    labels: {nodes: [{name: 'automerge:opt-in'}, {name: 'automerge:failed'}]},
    reviewRequests: {nodes: [{requestedReviewer: {login: 'ben'}}, {requestedReviewer: {combinedSlug: 'movelab/web'}}]},
    latestReviews: {
        nodes: [
            {state: 'APPROVED', author: {login: 'mkolkman'}},
            {state: 'COMMENTED', author: {login: 'x'}},
        ],
    },
    reviewThreads: {
        nodes: [{isResolved: false, comments: {totalCount: 2, nodes: [{body: 'Why?'}]}}, {isResolved: true}],
    },
    commits: {
        nodes: [
            {
                commit: {
                    status: {context: {state: 'FAILURE', description: 'it conflicts with main'}},
                    statusCheckRollup: {
                        contexts: {
                            nodes: [
                                {
                                    name: 'Unit tests',
                                    status: 'COMPLETED',
                                    conclusion: 'SUCCESS',
                                    startedAt: '2026-11-13T10:00:00Z',
                                },
                                {
                                    name: 'Lint',
                                    status: 'IN_PROGRESS',
                                    conclusion: null,
                                    startedAt: '2026-11-13T10:01:00Z',
                                },
                                {context: 'merge-queue/ci', state: 'PENDING', createdAt: '2026-11-13T10:02:00Z'},
                                {context: 'automerge', state: 'FAILURE', createdAt: '2026-11-13T10:02:00Z'},
                                {context: 'deploy', state: 'ERROR', createdAt: null},
                            ],
                        },
                    },
                },
            },
        ],
    },
};

const LANE_DATA = {
    viewer: {login: 'JBlaak'},
    repository: {
        nameWithOwner: 'MoveLab-Studio/Connect',
        defaultBranchRef: {
            name: 'main',
            target: {oid: '954e4ca'},
            rules: {
                nodes: [
                    {type: 'REQUIRED_STATUS_CHECKS', parameters: {requiredStatusChecks: [{context: 'Unit tests'}]}},
                    {
                        type: 'PULL_REQUEST',
                        parameters: {dismissStaleReviewsOnPush: false, requireLastPushApproval: false},
                    },
                    {type: 'DELETION', parameters: null},
                    {
                        type: 'REQUIRED_STATUS_CHECKS',
                        parameters: {requiredStatusChecks: [{context: 'Unit tests'}, {context: 'Lint'}]},
                    },
                ],
            },
        },
        pr2450: PR_NODE,
        pr2451: null,
    },
};

test('the lane query asks for each PR by its own alias, with the trunk and its rules', () => {
    /* When */
    const query = laneQuery([2450, 2451]);

    /* Then */
    assert.match(query, /pr2450: pullRequest\(number: 2450\) \{ \.\.\.laneFields \}/);
    assert.match(query, /pr2451: pullRequest\(number: 2451\)/);
    assert.match(query, /defaultBranchRef \{\s+name\s+target \{ oid \}\s+rules\(first: 50\)/);
    assert.match(query, /headRefOid/);
});

test('a lane read maps every field the stage model needs, and leaves out a number GitHub does not know', () => {
    /* When */
    const read = toLaneRead(LANE_DATA, 'MoveLab-Studio/Connect', [2450, 2451]);

    /* Then */
    assert.equal(read?.viewer, 'JBlaak');
    assert.equal(read?.trunk, 'main');
    assert.equal(read?.trunkOid, '954e4ca');
    assert.deepEqual(read?.rules, {requiredChecks: ['Unit tests', 'Lint'], approvalLostOnPush: false});
    assert.equal(read?.pullRequests.length, 1);
    assert.deepEqual(read?.pullRequests[0], {
        repository: 'MoveLab-Studio/Connect',
        number: 2450,
        title: 'Add equipment categories',
        url: 'https://github.com/MoveLab-Studio/Connect/pull/2450',
        author: 'JBlaak',
        state: 'open',
        mergedAt: null,
        draft: false,
        headRef: '2446-equipment',
        headOid: 'e445365',
        baseRef: 'main',
        labels: ['automerge:opt-in', 'automerge:failed'],
        automerge: {state: 'failure', description: 'it conflicts with main'},
        review: 'approved',
        approvedBy: ['mkolkman'],
        requestedReviewers: ['ben', 'movelab/web'],
        unresolvedThreads: 1,
        mergeState: 'dirty',
        checks: [
            {name: 'Unit tests', state: 'passed', startedAt: Date.parse('2026-11-13T10:00:00Z')},
            {name: 'Lint', state: 'running', startedAt: Date.parse('2026-11-13T10:01:00Z')},
            {name: 'merge-queue/ci', state: 'running', startedAt: Date.parse('2026-11-13T10:02:00Z')},
            {name: 'deploy', state: 'failed', startedAt: null},
        ],
    });
});

test('a merged PR reads as merged with its time; no repository or trunk reads as nothing', () => {
    /* Given */
    const merged = {
        ...LANE_DATA,
        repository: {...LANE_DATA.repository, pr2450: {...PR_NODE, state: 'MERGED', mergedAt: '2026-11-13T11:00:00Z'}},
    };

    /* When */
    const read = toLaneRead(merged, 'MoveLab-Studio/Connect', [2450]);
    const none = toLaneRead({repository: null}, 'x/y', [1]);
    const empty = toLaneRead({repository: {defaultBranchRef: null}}, 'x/y', [1]);

    /* Then */
    assert.equal(read?.pullRequests[0].state, 'merged');
    assert.equal(read?.pullRequests[0].mergedAt, '2026-11-13T11:00:00Z');
    assert.equal(none, null);
    assert.equal(empty, null);
});

test('a rule that dismisses or blocks an approval on a push is read as losing the approval', () => {
    /* Given */
    const dismiss = [{type: 'PULL_REQUEST', parameters: {dismissStaleReviewsOnPush: true}}];
    const lastPush = [{type: 'PULL_REQUEST', parameters: {requireLastPushApproval: true}}];

    /* When */
    const rules = [toTrunkRules(dismiss), toTrunkRules(lastPush), toTrunkRules(null)];

    /* Then */
    assert.deepEqual(
        rules.map((rule) => rule.approvalLostOnPush),
        [true, true, false],
    );
});

test('the queued search finds my open PRs with any queue label, and maps each to its repository', () => {
    /* Given */
    const data = {
        search: {
            nodes: [
                {number: 2450, repository: {nameWithOwner: 'MoveLab-Studio/Connect'}},
                {},
                {number: 7, repository: {nameWithOwner: 'JBlaak/switchboard'}},
            ],
        },
    };

    /* When */
    const found = toQueuedPullRequests(data);

    /* Then */
    assert.equal(
        QUEUED_SEARCH,
        'is:pr is:open author:@me archived:false label:"automerge:opt-in","automerge:next","automerge:failed"',
    );
    assert.deepEqual(found, [
        {repository: 'MoveLab-Studio/Connect', number: 2450},
        {repository: 'JBlaak/switchboard', number: 7},
    ]);
    assert.equal(toQueuedPullRequests({}), null);
});

test('the workflow tree maps to its files; a repository without the directory has none', () => {
    /* Given */
    const data = {
        repository: {
            object: {
                entries: [
                    {name: 'merge_queue.yml', object: {text: 'uses: MoveLab-Studio/merge-queue@v1'}},
                    {name: 'shared', object: {}},
                ],
            },
        },
    };

    /* When */
    const files = toWorkflowFiles(data);
    const missing = toWorkflowFiles({repository: {object: null}});
    const unavailable = toWorkflowFiles({});

    /* Then */
    assert.deepEqual(files, [{name: 'merge_queue.yml', text: 'uses: MoveLab-Studio/merge-queue@v1'}]);
    assert.deepEqual(missing, []);
    assert.equal(unavailable, null);
});

test('gh is asked the lane query with the owner and name as variables', async () => {
    /* Given */
    const asked: string[][] = [];
    const gh = new GhCli({
        run: async (args) => {
            asked.push([...args]);
            return {missing: false, code: 0, stdout: JSON.stringify({data: LANE_DATA}), stderr: ''};
        },
    });

    /* When */
    const read = await gh.laneRead('MoveLab-Studio/Connect', [2450, 2450, -1]);

    /* Then */
    assert.equal(read?.pullRequests.length, 1);
    assert.deepEqual(asked[0].slice(-4), ['-f', 'owner=MoveLab-Studio', '-f', 'name=Connect']);
    assert.match(asked[0][3], /pr2450: pullRequest/);
    assert.doesNotMatch(asked[0][3], /pr-1/);
});
