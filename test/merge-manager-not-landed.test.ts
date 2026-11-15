/**
 * Not landed: what each of the user's open PRs says, which are left out
 * because they are in a lane, the order, and the Not landed page's chips.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    canLand,
    inRepository,
    notLanded,
    notLandedMeta,
    notLandedRepositories,
    notLandedStatus,
    openedAgo,
    type OpenPullRequest,
} from '../src/domain/merge-manager/not-landed';
import {EMPTY_MERGE_MANAGER_STATE, landedKey, type MergeManagerState} from '../src/domain/merge-manager/model';

const NOW = Date.UTC(2026, 10, 15, 10, 0);
const HOUR = 3_600_000;

function open(number: number, hoursAgo: number, over: Partial<OpenPullRequest> = {}): OpenPullRequest {
    return {
        repository: 'JBlaak/switchboard',
        number,
        title: `PR ${number}`,
        url: `https://github.com/JBlaak/switchboard/pull/${number}`,
        isDraft: false,
        createdAt: NOW - hoursAgo * HOUR,
        headRef: `branch-${number}`,
        reviewDecision: null,
        mergeable: 'MERGEABLE',
        checks: 'success',
        reviewRequested: [],
        changesRequestedBy: [],
        approvedBy: [],
        ...over,
    };
}

function lanesWith(repository: string, number: number): MergeManagerState {
    return {
        needsYou: 0,
        lanes: [
            {
                repository,
                kind: 'switchboard',
                approvalLostOnPush: false,
                pullRequests: [{key: landedKey(repository, number)} as never],
            },
        ],
    };
}

test('an approved PR with green checks is ready to land', () => {
    /* Given */
    const pr = open(1, 1, {reviewDecision: 'APPROVED', approvedBy: ['sam']});

    /* When */
    const status = notLandedStatus(pr);

    /* Then */
    assert.equal(status, 'ready');
    assert.equal(notLandedMeta(pr, NOW), 'switchboard · branch-1 · opened 1 h ago · approved by sam');
});

test('an approved PR whose checks still run says so', () => {
    /* Given */
    const pr = open(1, 1, {reviewDecision: 'APPROVED', checks: 'pending'});

    /* When */
    const status = notLandedStatus(pr);

    /* Then */
    assert.equal(status, 'checksRunning');
});

test('a draft is a draft whatever else is true, and offers no Land it', () => {
    /* Given */
    const pr = open(1, 1, {isDraft: true, mergeable: 'CONFLICTING', checks: 'failure'});

    /* When */
    const status = notLandedStatus(pr);

    /* Then */
    assert.equal(status, 'draft');
    assert.equal(canLand(pr), false);
});

test('conflicts come before failing checks, and failing checks before changes asked', () => {
    /* Given */
    const conflicting = open(1, 1, {mergeable: 'CONFLICTING', checks: 'failure', reviewDecision: 'CHANGES_REQUESTED'});
    const failing = open(2, 1, {checks: 'failure', reviewDecision: 'CHANGES_REQUESTED'});
    const changes = open(3, 1, {reviewDecision: 'CHANGES_REQUESTED', changesRequestedBy: ['sam']});

    /* When */
    const statuses = [conflicting, failing, changes].map(notLandedStatus);

    /* Then */
    assert.deepEqual(statuses, ['conflicts', 'checksFailing', 'changesAsked']);
    assert.match(notLandedMeta(changes, NOW), /changes asked by sam$/);
});

test('a PR waits in review when a review is asked, else nobody was asked yet', () => {
    /* Given */
    const asked = open(1, 30, {reviewDecision: 'REVIEW_REQUIRED', reviewRequested: ['sam']});
    const nobody = open(2, 30);

    /* When */
    const statuses = [asked, nobody].map(notLandedStatus);

    /* Then */
    assert.deepEqual(statuses, ['inReview', 'noReview']);
    assert.equal(notLandedMeta(asked, NOW), 'switchboard · branch-1 · opened 1 d ago · review asked of sam');
});

test('PRs in a lane are left out, and the rest are newest opened first', () => {
    /* Given */
    const prs = [open(10, 5), open(11, 1), open(12, 3)];
    const lanes = lanesWith('jblaak/SWITCHBOARD', 12);

    /* When */
    const rows = notLanded(prs, lanes);

    /* Then */
    assert.deepEqual(
        rows.map((pr) => pr.number),
        [11, 10],
    );
});

test('with no lanes every open PR is not landed', () => {
    /* Given */
    const prs = [open(1, 2), open(2, 1)];

    /* When */
    const rows = notLanded(prs, EMPTY_MERGE_MANAGER_STATE);

    /* Then */
    assert.deepEqual(
        rows.map((pr) => pr.number),
        [2, 1],
    );
});

test('the chips count each repository, most first, and a chip keeps only its rows', () => {
    /* Given */
    const rows = [
        open(1, 1, {repository: 'JBlaak/Patch'}),
        open(2, 2),
        open(3, 3),
        open(4, 4, {repository: 'JBlaak/BlaakTasks'}),
    ];

    /* When */
    const chips = notLandedRepositories(rows);
    const patch = inRepository(rows, 'jblaak/patch');

    /* Then */
    assert.deepEqual(chips, [
        {repository: 'JBlaak/switchboard', count: 2},
        {repository: 'JBlaak/BlaakTasks', count: 1},
        {repository: 'JBlaak/Patch', count: 1},
    ]);
    assert.deepEqual(
        patch.map((pr) => pr.number),
        [1],
    );
    assert.equal(inRepository(rows, null).length, 4);
});

test('the age reads in minutes, hours, then days', () => {
    /* Given */
    const times = [NOW - 20_000, NOW - 5 * 60_000, NOW - 2 * HOUR, NOW - 50 * HOUR];

    /* When */
    const words = times.map((at) => openedAgo(at, NOW));

    /* Then */
    assert.deepEqual(words, ['just now', '5 min ago', '2 h ago', '2 d ago']);
});
