/**
 * A Fix branch's PR as `gh`'s GraphQL answers it (#414): its state, its
 * checks taken together and, once merged, its merge commit; and the tags
 * read to find the first one that contains it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toBranchPullRequest} from '../src/infrastructure/github/gh-branch-pr';
import {toTags} from '../src/infrastructure/github/gh-tags';

function answer(node: unknown): unknown {
    return {repository: {pullRequests: {nodes: node ? [node] : []}}};
}

function prNode(overrides: Record<string, unknown> = {}, checks: unknown[] = []): Record<string, unknown> {
    return {
        number: 241,
        url: 'https://github.com/movelab/connect/pull/241',
        state: 'OPEN',
        isDraft: false,
        mergedAt: null,
        mergeCommit: null,
        commits: {nodes: [{commit: {statusCheckRollup: {contexts: {nodes: checks}}}}]},
        ...overrides,
    };
}

const run = (name: string, status: string, conclusion: string | null = null) => ({
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
});

test('a branch without a PR answers none', () => {
    /* Then */
    assert.deepEqual(toBranchPullRequest(answer(null)), {pr: null});
});

test('an answer without the repository is not an answer', () => {
    /* Then */
    assert.equal(toBranchPullRequest({repository: null}), null);
});

test('an open PR with a running check is pending, its passed checks counted', () => {
    /* When */
    const read = toBranchPullRequest(
        answer(prNode({}, [run('unit', 'COMPLETED', 'SUCCESS'), run('e2e', 'IN_PROGRESS')])),
    );

    /* Then */
    assert.deepEqual(read?.pr?.checks, {state: 'pending', passed: 1, total: 2, failing: []});
    assert.equal(read?.pr?.state, 'open');
});

test('a failed check fails the PR and is named; a skipped one is not counted', () => {
    /* When */
    const read = toBranchPullRequest(
        answer(
            prNode({}, [
                run('unit', 'COMPLETED', 'SUCCESS'),
                run('e2e', 'COMPLETED', 'FAILURE'),
                run('deploy', 'COMPLETED', 'SKIPPED'),
            ]),
        ),
    );

    /* Then */
    assert.deepEqual(read?.pr?.checks, {state: 'failing', passed: 1, total: 2, failing: ['e2e']});
});

test('a merged PR carries its merge commit and time', () => {
    /* When */
    const read = toBranchPullRequest(
        answer(prNode({state: 'MERGED', mergedAt: '2026-11-12T10:00:00Z', mergeCommit: {oid: 'abc1234'}})),
    );

    /* Then */
    assert.equal(read?.pr?.state, 'merged');
    assert.equal(read?.pr?.mergedAt, '2026-11-12T10:00:00Z');
    assert.equal(read?.pr?.mergeCommit, 'abc1234');
    assert.equal(read?.pr?.checks.state, 'none');
});

test('a draft PR reads as a draft', () => {
    /* Then */
    assert.equal(toBranchPullRequest(answer(prNode({isDraft: true})))?.pr?.state, 'draft');
});

test("tags come with an annotated tag's own date, else their commit's", () => {
    /* When */
    const tags = toTags({
        repository: {
            refs: {
                nodes: [
                    {name: 'v4.12.1', target: {tagger: {date: '2026-11-12T09:00:00Z'}}},
                    {name: 'v4.12.0', target: {committedDate: '2026-11-01T09:00:00Z'}},
                    {name: 'broken', target: null},
                ],
            },
        },
    });

    /* Then */
    assert.deepEqual(tags, [
        {name: 'v4.12.1', at: '2026-11-12T09:00:00Z'},
        {name: 'v4.12.0', at: '2026-11-01T09:00:00Z'},
    ]);
});
