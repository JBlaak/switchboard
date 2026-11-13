/**
 * The Merge manager's stage model (#423, #434): the queue lane read from the
 * queue's labels and `automerge` status, and the Switchboard lane in land
 * order with Held passed over and no pre-emption.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heldReason, headStep, queueLaneStage, switchboardLaneStages} from '../src/domain/merge-manager/stages';
import {QUEUE_LABELS} from '../src/domain/project/merge-queue';
import type {LaneEntry} from '../src/domain/merge-manager/stages';
import type {LanePullRequestRead, LaneStage, SetAside} from '../src/domain/merge-manager/model';
import {HEAD, MIN, NOW, NO_RULES, RULES, landedPr, prRead} from './support/merge-manager-fixtures';

// ── Queue lane ──

const OPTED_IN = [QUEUE_LABELS.optIn];

function queued(description: string, overrides: Partial<LanePullRequestRead> = {}): LanePullRequestRead {
    return prRead(1, {labels: OPTED_IN, automerge: {state: 'pending', description}, ...overrides});
}

test('each queue status and label maps to its stage', () => {
    /* Given */
    const cases: [LanePullRequestRead, LaneStage][] = [
        [queued('Number 3 in the merge queue'), {kind: 'waiting', willConflict: false, position: 3}],
        [queued('Waits for an approval'), {kind: 'held', reason: {kind: 'approval'}}],
        [
            queued('Waits for a review by @movelab/android'),
            {kind: 'held', reason: {kind: 'review', reviewer: 'movelab/android', team: true}},
        ],
        [queued('Waits until `feature-base` merges'), {kind: 'held', reason: {kind: 'base', base: 'feature-base'}}],
        [queued('Waits until #12 is ready for review'), {kind: 'held', reason: {kind: 'draft'}}],
        [prRead(1, {labels: OPTED_IN}), {kind: 'waiting', willConflict: false, position: null}],
        [queued('Something the queue says now'), {kind: 'waiting', willConflict: false, position: null}],
        [
            prRead(1, {labels: [QUEUE_LABELS.failed], automerge: {state: 'failure', description: 'CI failed'}}),
            {kind: 'fixing', cause: 'checks'},
        ],
        [
            prRead(1, {
                labels: [QUEUE_LABELS.failed],
                automerge: {state: 'failure', description: 'It conflicts with main'},
            }),
            {kind: 'fixing', cause: 'conflict'},
        ],
        [
            prRead(1, {labels: [QUEUE_LABELS.failed], automerge: {state: 'failure', description: 'Changes requested'}}),
            {kind: 'needsYou', reason: {kind: 'changes-requested'}},
        ],
        [
            prRead(1, {
                labels: [QUEUE_LABELS.failed],
                automerge: {state: 'failure', description: 'An unresolved thread'},
            }),
            {kind: 'needsYou', reason: {kind: 'unresolved-thread'}},
        ],
        [
            prRead(1, {labels: [QUEUE_LABELS.failed]}),
            {kind: 'needsYou', reason: {kind: 'merge-refused', reason: 'Failed in the merge queue'}},
        ],
        [prRead(1, {state: 'merged', mergedAt: new Date(NOW - MIN).toISOString()}), {kind: 'merged', at: NOW - MIN}],
    ];

    /* When */
    const stages = cases.map(([read]) => queueLaneStage(read, null, NOW));

    /* Then */
    assert.deepEqual(
        stages,
        cases.map(([, stage]) => stage),
    );
});

test('the queue head is updating until its checks show, then checks while any runs, then merging', () => {
    /* Given */
    const first = 'First in the merge queue; merges once CI passes';
    const updating = queued(first, {checks: []});
    const running = queued(first, {checks: [{name: 'Unit tests', state: 'running', startedAt: NOW}]});
    const done = queued(first);

    /* When */
    const steps = [updating, running, done].map((read) => queueLaneStage(read, null, NOW));

    /* Then */
    assert.deepEqual(steps, [
        {kind: 'head', step: 'updating'},
        {kind: 'head', step: 'checks'},
        {kind: 'head', step: 'merging'},
    ]);
});

test('a queue PR an errand gave up on needs you until a new commit lands', () => {
    /* Given */
    const failedRead = prRead(1, {
        labels: [QUEUE_LABELS.failed],
        automerge: {state: 'failure', description: 'CI failed'},
    });
    const gaveUp: SetAside = {kind: 'needsYou', cause: null, reason: {kind: 'errand-stopped'}, headOid: 'oid-1'};

    /* When */
    const same = queueLaneStage(failedRead, gaveUp, NOW);
    const pushed = queueLaneStage({...failedRead, headOid: 'oid-1b'}, gaveUp, NOW);

    /* Then */
    assert.deepEqual(same, {kind: 'needsYou', reason: {kind: 'errand-stopped'}});
    assert.deepEqual(pushed, {kind: 'fixing', cause: 'checks'});
});

// ── Switchboard lane ──

function lane(entries: LaneEntry[], rules = RULES) {
    return switchboardLaneStages(entries, {trunk: 'main', rules, now: NOW});
}

function stagesOf(entries: LaneEntry[], rules = RULES): Record<number, string> {
    const outcomes = lane(entries, rules);
    return Object.fromEntries(
        entries.map((entry) => [
            entry.landed.number,
            outcomes.find((outcome) => outcome.key === entry.landed.key)!.stage.kind,
        ]),
    );
}

test('the first PR in land order is the head and the rest wait, in land order', () => {
    /* Given */
    const entries = [
        {landed: landedPr(3, 5), read: prRead(3)},
        {landed: landedPr(1, 30), read: prRead(1)},
        {landed: landedPr(2, 10), read: prRead(2)},
    ];

    /* When */
    const outcomes = lane(entries);

    /* Then */
    assert.deepEqual(
        outcomes.map((outcome) => [outcome.key.split('#')[1], outcome.stage.kind]),
        [
            ['1', 'head'],
            ['2', 'waiting'],
            ['3', 'waiting'],
        ],
    );
});

test('a held PR keeps its place but is passed over for the head', () => {
    /* Given */
    const entries = [
        {landed: landedPr(1, 30), read: prRead(1, {review: 'review_required', approvedBy: []})},
        {landed: landedPr(2, 10), read: prRead(2)},
    ];

    /* When */
    const stages = stagesOf(entries);

    /* Then */
    assert.deepEqual(stages, {1: 'held', 2: 'head'});
});

test('no pre-emption: an earlier PR that becomes ready waits until the head is done', () => {
    /* Given */
    const entries = [
        {landed: landedPr(1, 30, 'switchboard', {kind: 'held', reason: {kind: 'approval'}}), read: prRead(1)},
        {landed: landedPr(2, 10, 'switchboard', HEAD), read: prRead(2)},
    ];

    /* When */
    const stages = stagesOf(entries);

    /* Then */
    assert.deepEqual(stages, {1: 'waiting', 2: 'head'});
});

test('a head that loses its approval drops back to held, and the next PR up becomes the head', () => {
    /* Given */
    const entries = [
        {landed: landedPr(1, 30, 'switchboard', HEAD), read: prRead(1, {review: 'review_required', approvedBy: []})},
        {landed: landedPr(2, 10), read: prRead(2)},
    ];

    /* When */
    const stages = stagesOf(entries);

    /* Then */
    assert.deepEqual(stages, {1: 'held', 2: 'head'});
});

test('held covers a draft, a stacked base, an outstanding review and a missing approval, in that order', () => {
    /* Given */
    const reads = [
        prRead(1, {draft: true, baseRef: 'other'}),
        prRead(2, {baseRef: 'feature-base', requestedReviewers: ['ben']}),
        prRead(3, {requestedReviewers: ['movelab/ios']}),
        prRead(4, {review: null, approvedBy: []}),
        prRead(5, {review: null, approvedBy: ['ben']}),
    ];

    /* When */
    const reasons = reads.map((read) => heldReason(read, 'main'));

    /* Then */
    assert.deepEqual(reasons, [
        {kind: 'draft'},
        {kind: 'base', base: 'feature-base'},
        {kind: 'review', reviewer: 'movelab/ios', team: true},
        {kind: 'approval'},
        null,
    ]);
});

test('requested changes and open threads need you, and keep the PR out of the head', () => {
    /* Given */
    const entries = [
        {landed: landedPr(1, 30), read: prRead(1, {review: 'changes_requested'})},
        {landed: landedPr(2, 20), read: prRead(2, {unresolvedThreads: 1})},
        {landed: landedPr(3, 10), read: prRead(3)},
    ];

    /* When */
    const outcomes = lane(entries);

    /* Then */
    assert.deepEqual(
        outcomes.map((outcome) => outcome.stage),
        [
            {kind: 'needsYou', reason: {kind: 'changes-requested'}},
            {kind: 'needsYou', reason: {kind: 'unresolved-thread'}},
            {kind: 'head', step: 'merging'},
        ],
    );
});

test('a head that fails out on a required check is set aside fixing on its commit, and the next becomes the head', () => {
    /* Given */
    const failing = prRead(1, {checks: [{name: 'Unit tests', state: 'failed', startedAt: NOW - MIN}]});
    const entries = [
        {landed: landedPr(1, 30, 'switchboard', HEAD), read: failing},
        {landed: landedPr(2, 10), read: prRead(2)},
    ];

    /* When */
    const [first, second] = lane(entries);

    /* Then */
    assert.deepEqual(first.stage, {kind: 'fixing', cause: 'checks'});
    assert.deepEqual(first.setAside, {kind: 'fixing', cause: 'checks', reason: null, headOid: 'oid-1'});
    assert.deepEqual(second.stage, {kind: 'head', step: 'merging'});
});

test('a PR that will conflict waits flagged, and fails out on the conflict once it is the head', () => {
    /* Given */
    const conflicting = prRead(2, {mergeState: 'dirty'});
    const waiting = [
        {landed: landedPr(1, 30, 'switchboard', HEAD), read: prRead(1)},
        {landed: landedPr(2, 10), read: conflicting},
    ];
    const asHead = [{landed: landedPr(2, 10), read: conflicting}];

    /* When */
    const flagged = lane(waiting)[1];
    const failedOut = lane(asHead)[0];

    /* Then */
    assert.deepEqual(flagged.stage, {kind: 'waiting', willConflict: true, position: null});
    assert.deepEqual(failedOut.stage, {kind: 'fixing', cause: 'conflict'});
});

test('fixing keeps its landed place: after the fix is pushed it waits behind the head again, ahead of later PRs', () => {
    /* Given */
    const aside: SetAside = {kind: 'fixing', cause: 'checks', reason: null, headOid: 'oid-1'};
    const fixing = {kind: 'fixing', cause: 'checks'} as const;
    const before = [
        {landed: landedPr(1, 30, 'switchboard', fixing, {setAside: aside}), read: prRead(1)},
        {landed: landedPr(2, 20, 'switchboard', HEAD), read: prRead(2)},
        {landed: landedPr(3, 10), read: prRead(3)},
    ];
    const pushed = before.map((entry) =>
        entry.landed.number === 1 ? {...entry, read: prRead(1, {headOid: 'oid-1-fixed'})} : entry,
    );

    /* When */
    const still = stagesOf(before);
    const after = lane(pushed);

    /* Then */
    assert.deepEqual(still, {1: 'fixing', 2: 'head', 3: 'waiting'});
    assert.deepEqual(
        after.map((outcome) => [outcome.key.split('#')[1], outcome.stage.kind, outcome.setAside]),
        [
            ['1', 'waiting', null],
            ['2', 'head', null],
            ['3', 'waiting', null],
        ],
    );
});

test('a failed check on a head that is behind the trunk is not a fail-out: its update brings a new run', () => {
    /* Given */
    const behind = prRead(1, {
        mergeState: 'behind',
        checks: [{name: 'Unit tests', state: 'failed', startedAt: NOW - MIN}],
    });

    /* When */
    const [outcome] = lane([{landed: landedPr(1, 30), read: behind}]);

    /* Then */
    assert.deepEqual(outcome.stage, {kind: 'head', step: 'updating'});
});

test('the head step judges the required checks only, and every check when none is required', () => {
    /* Given */
    const optionalRunning = prRead(1, {
        checks: [
            {name: 'Unit tests', state: 'passed', startedAt: NOW},
            {name: 'Lint', state: 'running', startedAt: NOW},
        ],
    });
    const requiredMissing = prRead(1, {checks: [{name: 'Lint', state: 'passed', startedAt: NOW}]});
    const requiredCancelled = prRead(1, {checks: [{name: 'Unit tests', state: 'cancelled', startedAt: NOW}]});

    /* When */
    const steps = [
        headStep(optionalRunning, RULES),
        headStep(optionalRunning, NO_RULES),
        headStep(requiredMissing, RULES),
        headStep(requiredCancelled, RULES),
    ];

    /* Then */
    assert.deepEqual(steps, ['merging', 'checks', 'checks', 'updating']);
});

test('a merged PR is merged, whatever else it reads as', () => {
    /* Given */
    const merged = prRead(1, {state: 'merged', mergedAt: null, review: 'changes_requested'});

    /* When */
    const [outcome] = lane([{landed: landedPr(1, 30, 'switchboard', HEAD), read: merged}]);

    /* Then */
    assert.deepEqual(outcome.stage, {kind: 'merged', at: NOW});
});
