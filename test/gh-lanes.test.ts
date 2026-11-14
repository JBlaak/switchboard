/**
 * The Merge manager's GitHub reads (#434): the slim lane query and how its
 * answer, the queued-PR search and the workflow tree map onto the lane's
 * reads, from responses shaped as GitHub answers them.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    QUEUED_SEARCH,
    httpStatus,
    laneQuery,
    toBranchUpdateFailure,
    toLaneRead,
    toQueuedPullRequests,
    toTrunkRules,
    toWorkflowFiles,
} from '../src/infrastructure/github/gh-lanes';
import {GhCli} from '../src/infrastructure/github/gh-cli';

const PR_NODE = {
    id: 'PR_kwDOAbc',
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
                    checkSuites: {
                        nodes: [
                            {status: 'IN_PROGRESS', conclusion: null, workflowRun: {databaseId: 901}},
                            {status: 'COMPLETED', conclusion: 'CANCELLED', workflowRun: {databaseId: 902}},
                            {status: 'COMPLETED', conclusion: 'SUCCESS', workflowRun: {databaseId: 903}},
                            {status: 'QUEUED', conclusion: null, workflowRun: null},
                        ],
                    },
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
        squashMergeAllowed: true,
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
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
    assert.deepEqual(read?.rules, {
        requiredChecks: ['Unit tests', 'Lint'],
        approvalLostOnPush: false,
        mergeMethods: null,
        linearHistory: false,
    });
    assert.deepEqual(read?.mergeMethods, ['squash', 'merge']);
    assert.equal(read?.pullRequests.length, 1);
    assert.deepEqual(read?.pullRequests[0], {
        id: 'PR_kwDOAbc',
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
        runs: [
            {id: 901, state: 'unfinished'},
            {id: 902, state: 'cancelled'},
            {id: 903, state: 'finished'},
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

test('the merge methods every ruleset allows are taken together, and a linear history is read', () => {
    /* Given */
    const nodes = [
        {type: 'PULL_REQUEST', parameters: {allowedMergeMethods: ['MERGE', 'SQUASH', 'REBASE']}},
        {type: 'PULL_REQUEST', parameters: {allowedMergeMethods: ['SQUASH', 'REBASE']}},
        {type: 'REQUIRED_LINEAR_HISTORY', parameters: null},
    ];

    /* When */
    const rules = toTrunkRules(nodes);

    /* Then */
    assert.deepEqual(rules.mergeMethods, ['squash', 'rebase']);
    assert.equal(rules.linearHistory, true);
});

test("the lane query asks for the node id, the head commit's workflow runs and the merge settings", () => {
    /* When */
    const query = laneQuery([1]);

    /* Then */
    assert.match(query, /laneFields on PullRequest \{\n {2}id number/);
    assert.match(query, /checkSuites\(first: 20\) \{ nodes \{ status conclusion workflowRun \{ databaseId \} \} \}/);
    assert.match(query, /squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed/);
    assert.match(query, /allowedMergeMethods/);
});

// ── The lane runner's writes (#435) ──

test('a refused branch update reads as a conflict, a moved head, GitHub out of reach, or a refusal', () => {
    /* When */
    const reasons = [
        'Cannot update PR branch due to conflicts',
        'Expected head oid does not match the current head',
        'GitHub did not answer',
        'gh is not signed in to github.com',
        'Resource not accessible by integration',
    ].map(toBranchUpdateFailure);

    /* Then */
    assert.deepEqual(reasons, ['conflict', 'moved', 'unavailable', 'unavailable', 'refused']);
});

test('the HTTP status gh printed is read from its error line', () => {
    /* Then */
    assert.equal(httpStatus('gh: Pull Request is not mergeable (HTTP 405)\n'), 405);
    assert.equal(httpStatus('gh: Head branch was modified. Review and try the merge again. (HTTP 409)'), 409);
    assert.equal(httpStatus('connection reset'), null);
});

test('right before a merge the head is compared with the trunk: behind, up to date, or unknown', async () => {
    /* Given */
    const asked: string[][] = [];
    const answers = [
        {behind_by: 2, ahead_by: 1},
        {behind_by: 0, ahead_by: 3},
    ];
    const gh = new GhCli({
        run: async (args) => {
            asked.push([...args]);
            const body = answers.shift();
            return body
                ? {missing: false, code: 0, stdout: JSON.stringify(body), stderr: ''}
                : {missing: false, code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)'};
        },
    });

    /* When */
    const behind = await gh.headBehind('MoveLab-Studio/Connect', 'main', 'e445365');
    const upToDate = await gh.headBehind('MoveLab-Studio/Connect', 'main', 'e445365');
    const unknown = await gh.headBehind('MoveLab-Studio/Connect', 'main', 'e445365');
    const refused = await gh.headBehind('MoveLab-Studio/Connect', 'main; rm', 'e445365');

    /* Then */
    assert.deepEqual(asked[0], ['api', 'repos/MoveLab-Studio/Connect/compare/main...e445365']);
    assert.equal(asked.length, 3);
    assert.equal(behind, true);
    assert.equal(upToDate, false);
    assert.equal(unknown, null);
    assert.equal(refused, null);
});

test('a merge is asked with the head SHA and the method, and a refusal answers its HTTP status', async () => {
    /* Given */
    const asked: string[][] = [];
    const gh = new GhCli({
        run: async (args) => {
            asked.push([...args]);
            return {
                missing: false,
                code: 1,
                stdout: JSON.stringify({message: 'Pull Request is not mergeable'}),
                stderr: 'gh: Pull Request is not mergeable (HTTP 405)\n',
            };
        },
    });

    /* When */
    const answer = await gh.mergePullRequest('MoveLab-Studio/Connect', 2450, 'e445365', 'squash');
    const refused = await gh.mergePullRequest('MoveLab-Studio/Connect', 2450, 'not a sha', 'squash');

    /* Then */
    assert.deepEqual(asked, [
        [
            'api',
            '--method',
            'PUT',
            'repos/MoveLab-Studio/Connect/pulls/2450/merge',
            '-f',
            'sha=e445365',
            '-f',
            'merge_method=squash',
        ],
    ]);
    assert.deepEqual(answer, {ok: false, status: 405, reason: 'Pull Request is not mergeable'});
    assert.equal(refused.ok, false);
});

test('a branch update is the REBASE mutation pinned to the expected head, and a conflict reads as one', async () => {
    /* Given */
    const asked: string[][] = [];
    const gh = new GhCli({
        run: async (args) => {
            asked.push([...args]);
            return {
                missing: false,
                code: 1,
                stdout: JSON.stringify({errors: [{message: 'Cannot update PR branch due to conflicts'}]}),
                stderr: '',
            };
        },
    });

    /* When */
    const answer = await gh.updateBranch('PR_kwDOAbc', 'e445365');

    /* Then */
    assert.match(
        asked[0][3],
        /updatePullRequestBranch\(input: \{.*expectedHeadOid: \$expectedHeadOid, updateMethod: REBASE \}/,
    );
    assert.deepEqual(asked[0].slice(4), ['-f', 'pullRequestId=PR_kwDOAbc', '-f', 'expectedHeadOid=e445365']);
    assert.deepEqual(answer, {ok: false, why: 'conflict', reason: 'Cannot update PR branch due to conflicts'});
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
