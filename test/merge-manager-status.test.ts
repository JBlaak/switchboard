/**
 * The Merge manager's page by status: which group each landed and not landed
 * PR goes in, the groups' order and the order within one, J/K's keys through
 * them, and a repository's not landed PRs counted by group.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {landedKey, type LandedPullRequest, type LaneStage} from '../src/domain/merge-manager/model';
import type {OpenPullRequest} from '../src/domain/merge-manager/not-landed';
import {pageLanes, type PageRow} from '../src/domain/merge-manager/page';
import {
    landedGroup,
    notLandedCounts,
    notLandedGroup,
    statusGroups,
    statusKeys,
} from '../src/domain/merge-manager/status';
import {MIN, NOW, REPO, landedPr} from './support/merge-manager-fixtures';

const HOUR = 60 * MIN;
const OTHER = 'movelab/other';

function open(number: number, hoursAgo: number, over: Partial<OpenPullRequest> = {}): OpenPullRequest {
    return {
        repository: REPO,
        number,
        title: `PR ${number}`,
        url: `https://github.com/${REPO}/pull/${number}`,
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

function rowAt(stage: LaneStage): PageRow {
    return pageLanes(mergeManagerState([landedPr(1, 30, 'switchboard', stage)], new Map()))[0]!.rows[0]!;
}

function other(number: number, minutesAgo: number, stage: LaneStage): LandedPullRequest {
    return landedPr(number, minutesAgo, 'switchboard', stage, {key: landedKey(OTHER, number), repository: OTHER});
}

test('a landed PR goes in the group its stage says', () => {
    /* Given */
    const stages: LaneStage[] = [
        {kind: 'needsYou', reason: {kind: 'changes-requested'}},
        {kind: 'needsYou', reason: {kind: 'merge-refused', reason: 'Base branch was modified'}},
        {kind: 'waiting', willConflict: true, position: null},
        {kind: 'head', step: 'checks'},
        {kind: 'fixing', cause: 'checks'},
        {kind: 'head', step: 'updating'},
        {kind: 'head', step: 'merging'},
        {kind: 'waiting', willConflict: false, position: null},
        {kind: 'held', reason: {kind: 'approval'}},
    ];

    /* When */
    const groups = stages.map((stage) => landedGroup(rowAt(stage)));

    /* Then */
    assert.deepEqual(groups, [
        'needsYou',
        'needsYou',
        'conflicts',
        'checks',
        'fixing',
        'merging',
        'merging',
        'line',
        'line',
    ]);
});

test('a not landed PR goes in the group its status says', () => {
    /* Given */
    const prs = [
        open(1, 1, {reviewDecision: 'CHANGES_REQUESTED'}),
        open(2, 1, {checks: 'failure'}),
        open(3, 1, {mergeable: 'CONFLICTING'}),
        open(4, 1, {reviewDecision: 'APPROVED', checks: 'pending'}),
        open(5, 1, {reviewDecision: 'APPROVED'}),
        open(6, 1, {reviewRequested: ['ana']}),
        open(7, 1),
        open(8, 1, {isDraft: true}),
    ];

    /* When */
    const groups = prs.map(notLandedGroup);

    /* Then */
    assert.deepEqual(groups, ['needsYou', 'needsYou', 'conflicts', 'checks', 'ready', 'review', 'review', 'drafts']);
});

test('the groups come in the page order, empty ones left out, landed before not landed and newest first', () => {
    /* Given */
    const lanes = pageLanes(
        mergeManagerState(
            [
                landedPr(1, 50, 'switchboard', {kind: 'head', step: 'checks'}),
                landedPr(2, 40),
                landedPr(3, 30, 'switchboard', {kind: 'held', reason: {kind: 'approval'}}),
                other(4, 60, {kind: 'needsYou', reason: {kind: 'unresolved-thread'}}),
            ],
            new Map(),
        ),
    );
    const notLanded = [
        open(10, 5, {checks: 'failure'}),
        open(11, 1, {reviewDecision: 'APPROVED', checks: 'pending'}),
        open(12, 2, {isDraft: true}),
        open(13, 3, {reviewDecision: 'CHANGES_REQUESTED'}),
    ];

    /* When */
    const groups = statusGroups(lanes, notLanded);

    /* Then */
    assert.deepEqual(
        groups.map((group) => [group.id, group.items.map((item) => item.key)]),
        [
            ['needsYou', [landedKey(OTHER, 4), landedKey(REPO, 13), landedKey(REPO, 10)]],
            ['checks', [landedKey(REPO, 1), landedKey(REPO, 11)]],
            ['line', [landedKey(REPO, 2), landedKey(REPO, 3)]],
            ['drafts', [landedKey(REPO, 12)]],
        ],
    );
    assert.equal(groups[0]!.prominent, true);
    assert.equal(groups[3]!.folded, true);
    assert.deepEqual(
        groups[0]!.items.map((item) => item.kind),
        ['lane', 'notLanded', 'notLanded'],
    );
});

test("J/K's keys go top to bottom through the groups", () => {
    /* Given */
    const lanes = pageLanes(
        mergeManagerState([landedPr(1, 50, 'switchboard', {kind: 'head', step: 'merging'})], new Map()),
    );
    const groups = statusGroups(lanes, [open(10, 1, {reviewDecision: 'APPROVED'}), open(11, 1, {checks: 'failure'})]);

    /* When */
    const keys = statusKeys(groups);

    /* Then */
    assert.deepEqual(keys, [landedKey(REPO, 11), landedKey(REPO, 1), landedKey(REPO, 10)]);
});

test('nothing at all makes no groups', () => {
    /* Given */
    const lanes = pageLanes(mergeManagerState([], new Map()));

    /* When */
    const groups = statusGroups(lanes, []);

    /* Then */
    assert.deepEqual(groups, []);
});

test("a repository's not landed PRs are counted by group, in the page order, whatever its case", () => {
    /* Given */
    const lanes = pageLanes(mergeManagerState([landedPr(1, 50)], new Map()));
    const groups = statusGroups(lanes, [
        open(10, 1),
        open(11, 2, {reviewRequested: ['ana']}),
        open(12, 3, {reviewDecision: 'APPROVED'}),
        open(13, 4, {repository: OTHER, isDraft: true}),
    ]);

    /* When */
    const counts = notLandedCounts(groups, REPO.toUpperCase());
    const none = notLandedCounts(groups, 'movelab/nothing');

    /* Then */
    assert.deepEqual(counts, [
        {id: 'ready', name: 'Ready to land', count: 1},
        {id: 'review', name: 'Waiting on review', count: 2},
    ]);
    assert.deepEqual(none, []);
});
