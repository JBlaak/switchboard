/**
 * Which PRs are landed (#434): the lane kind from the workflows, landing and
 * unlanding's labels, a poll folding a lane read in, and what the renderer is
 * shown.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {laneKindOf} from '../src/domain/merge-manager/lane-kind';
import {
    MERGED_KEPT_MS,
    expiredMerged,
    landLabels,
    landRefusal,
    mergeManagerState,
    syncLane,
    unlandLabels,
} from '../src/domain/merge-manager/landed';
import {QUEUE_LABELS} from '../src/domain/project/merge-queue';
import {HEAD, ME, MIN, NOW, RULES, landedPr, laneRead, prRead} from './support/merge-manager-fixtures';

// ── Lane kind ──

test('a repository whose workflows use the merge-queue Action is a queue lane, with or without labelled PRs', () => {
    /* Given */
    const step = {
        name: 'merge_queue.yml',
        text: 'jobs:\n  pass:\n    steps:\n      - uses: MoveLab-Studio/merge-queue@v1\n',
    };
    const trigger = {
        name: 'merge_queue_trigger.yml',
        text: 'jobs:\n  trigger:\n    uses: MoveLab-Studio/merge-queue/.github/workflows/trigger.yml@v1\n',
    };

    /* When */
    const kinds = [laneKindOf([step]), laneKindOf([trigger])];

    /* Then */
    assert.deepEqual(kinds, ['queue', 'queue']);
});

test('a repository without the Action, with it commented out or outside a workflow file, is a Switchboard lane', () => {
    /* Given */
    const none = [{name: 'test.yml', text: 'steps:\n  - uses: actions/checkout@v4\n'}];
    const commented = [{name: 'old.yml', text: '# - uses: MoveLab-Studio/merge-queue@v1\n'}];
    const readme = [{name: 'README.md', text: 'uses: MoveLab-Studio/merge-queue@v1'}];
    const lookalike = [{name: 'ci.yml', text: '  - uses: MoveLab-Studio/merge-queue-tools@v1\n'}];

    /* When */
    const kinds = [none, commented, readme, lookalike, []].map(laneKindOf);

    /* Then */
    assert.deepEqual(kinds, ['switchboard', 'switchboard', 'switchboard', 'switchboard', 'switchboard']);
});

// ── Land and unland ──

test('only my own open, non-draft PRs land', () => {
    /* Given */
    const reads = [
        prRead(1),
        prRead(2, {author: 'ben'}),
        prRead(3, {state: 'closed'}),
        prRead(4, {draft: true}),
        prRead(5, {author: 'JORIS'}),
    ];

    /* When */
    const refusals = reads.map((read) => landRefusal(read, ME));

    /* Then */
    assert.deepEqual(refusals, [
        null,
        'Only your own pull requests land',
        '#3 is closed',
        'Mark it ready for review first',
        null,
    ]);
});

test('landing adds the opt-in label in a queue lane only, and takes autorebase off in both', () => {
    /* Given */
    const read = prRead(1, {labels: [QUEUE_LABELS.rebaseOptIn]});

    /* When */
    const queue = landLabels(read, 'queue');
    const switchboard = landLabels(read, 'switchboard');

    /* Then */
    assert.deepEqual(queue, {add: [QUEUE_LABELS.optIn], remove: [QUEUE_LABELS.rebaseOptIn]});
    assert.deepEqual(switchboard, {add: [], remove: [QUEUE_LABELS.rebaseOptIn]});
});

test('unlanding takes the queue labels it carries off in a queue lane, and writes nothing in a Switchboard lane', () => {
    /* Given */
    const read = prRead(1, {labels: [QUEUE_LABELS.optIn, QUEUE_LABELS.failed, 'bug']});

    /* When */
    const queue = unlandLabels(read, 'queue');
    const switchboard = unlandLabels(read, 'switchboard');

    /* Then */
    assert.deepEqual(queue, [QUEUE_LABELS.optIn, QUEUE_LABELS.failed]);
    assert.deepEqual(switchboard, []);
});

// ── A poll ──

test('in a queue lane every PR of mine with a queue label is landed, wherever the label was added', () => {
    /* Given */
    const read = laneRead([
        prRead(1, {labels: [QUEUE_LABELS.optIn]}),
        prRead(2, {labels: [QUEUE_LABELS.next]}),
        prRead(3, {labels: [QUEUE_LABELS.optIn], author: 'ben'}),
        prRead(4, {labels: [QUEUE_LABELS.optIn], draft: true}),
        prRead(5),
    ]);

    /* When */
    const sync = syncLane([], read, 'queue', NOW);

    /* Then */
    assert.deepEqual(
        sync.landed.map((pr) => [pr.number, pr.lane, pr.landedAt]),
        [
            [1, 'queue', NOW],
            [2, 'queue', NOW],
        ],
    );
});

test('a queue PR whose labels all came off is unlanded; a Switchboard lane PR needs no label', () => {
    /* Given */
    const queueKnown = [landedPr(1, 30, 'queue')];
    const switchboardKnown = [landedPr(1, 30, 'switchboard')];
    const read = laneRead([prRead(1)]);

    /* When */
    const queue = syncLane(queueKnown, read, 'queue', NOW);
    const switchboard = syncLane(switchboardKnown, read, 'switchboard', NOW);

    /* Then */
    assert.deepEqual(queue.removed, ['movelab/connect#1']);
    assert.deepEqual(queue.landed, []);
    assert.deepEqual(switchboard.removed, []);
    assert.deepEqual(
        switchboard.landed.map((pr) => pr.stage.kind),
        ['head'],
    );
});

test('a landed PR closed without merging unlands itself, in either lane', () => {
    /* Given */
    const read = laneRead([prRead(1, {state: 'closed', labels: [QUEUE_LABELS.optIn]})]);

    /* When */
    const queue = syncLane([landedPr(1, 30, 'queue')], read, 'queue', NOW);
    const switchboard = syncLane([landedPr(1, 30, 'switchboard', HEAD)], read, 'switchboard', NOW);

    /* Then */
    assert.deepEqual(queue.removed, ['movelab/connect#1']);
    assert.deepEqual(switchboard.removed, ['movelab/connect#1']);
});

test('a landed PR the read left out keeps what it had, and a merged one is not touched', () => {
    /* Given */
    const merged = landedPr(1, 60, 'switchboard', {kind: 'merged', at: NOW - 30 * MIN});
    const missing = landedPr(2, 30, 'switchboard', HEAD);
    const read = laneRead([prRead(1, {state: 'closed'})]);

    /* When */
    const sync = syncLane([merged, missing], read, 'switchboard', NOW);

    /* Then */
    assert.deepEqual(sync.removed, []);
    assert.deepEqual(sync.landed, [merged, missing]);
});

test('a poll keeps the landed time and refreshes the title and branch', () => {
    /* Given */
    const known = [landedPr(1, 30)];
    const read = laneRead([prRead(1, {title: 'Renamed', headRef: 'renamed'})]);

    /* When */
    const [pr] = syncLane(known, read, 'switchboard', NOW).landed;

    /* Then */
    assert.equal(pr.landedAt, NOW - 30 * MIN);
    assert.equal(pr.title, 'Renamed');
    assert.equal(pr.headRef, 'renamed');
});

test('a merged PR goes once it has been merged for a week', () => {
    /* Given */
    const prs = [
        landedPr(1, 0, 'switchboard', {kind: 'merged', at: NOW - MERGED_KEPT_MS}),
        landedPr(2, 0, 'switchboard', {kind: 'merged', at: NOW - MERGED_KEPT_MS + MIN}),
        landedPr(3, 0, 'switchboard', HEAD),
    ];

    /* When */
    const expired = expiredMerged(prs, NOW);

    /* Then */
    assert.deepEqual(expired, ['movelab/connect#1']);
});

// ── What the renderer is shown ──

test('a lane lists its PRs in land order with places, merged ones last, and counts those that need me', () => {
    /* Given */
    const prs = [
        landedPr(4, 50, 'switchboard', {kind: 'merged', at: NOW - MIN}),
        landedPr(3, 5),
        landedPr(1, 30, 'switchboard', HEAD),
        landedPr(2, 20, 'switchboard', {kind: 'needsYou', reason: {kind: 'changes-requested'}}),
        landedPr(5, 1),
    ];

    /* When */
    const state = mergeManagerState(prs, new Map([['movelab/connect', {...RULES, approvalLostOnPush: true}]]));

    /* Then */
    assert.equal(state.needsYou, 1);
    assert.equal(state.lanes.length, 1);
    assert.equal(state.lanes[0].kind, 'switchboard');
    assert.equal(state.lanes[0].approvalLostOnPush, true);
    assert.deepEqual(
        state.lanes[0].pullRequests.map((pr) => [pr.number, pr.place]),
        [
            [1, 1],
            [2, null],
            [3, 2],
            [5, 3],
            [4, null],
        ],
    );
});

test('a queue lane takes its places from the queue, and never warns about approvals', () => {
    /* Given */
    const prs = [
        landedPr(1, 30, 'queue', {kind: 'waiting', willConflict: false, position: 4}),
        landedPr(2, 20, 'queue', {kind: 'head', step: 'checks'}),
    ];

    /* When */
    const state = mergeManagerState(prs, new Map([['movelab/connect', {...RULES, approvalLostOnPush: true}]]));

    /* Then */
    assert.equal(state.lanes[0].approvalLostOnPush, false);
    assert.deepEqual(
        state.lanes[0].pullRequests.map((pr) => [pr.number, pr.place]),
        [
            [1, 4],
            [2, 1],
        ],
    );
});
