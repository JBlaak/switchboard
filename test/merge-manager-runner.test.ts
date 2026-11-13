/**
 * The Switchboard lane runner's decisions (#435): green judgement, merge
 * method choice, what the head and the PRs behind it get, and what a write's
 * answer leads to.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    EMPTY_MEMORY,
    FORCE_CANCEL_AFTER_MS,
    UPDATE_PATIENCE_MS,
    afterMerge,
    afterUpdate,
    isGreen,
    laneActions,
    mergeMethod,
    updatesNotPushed,
    type LaneInput,
    type RunnerMemory,
} from '../src/domain/merge-manager/runner';
import type {LandedPullRequest, LanePullRequestRead, LaneStage} from '../src/domain/merge-manager/model';
import {MIN, NOW, NO_RULES, RULES, landedPr, prRead} from './support/merge-manager-fixtures';

const WAITING: LaneStage = {kind: 'waiting', willConflict: false, position: null};

function head(step: 'updating' | 'checks' | 'merging'): LaneStage {
    return {kind: 'head', step};
}

function entry(number: number, stage: LaneStage, read: Partial<LanePullRequestRead> = {}) {
    return {
        landed: landedPr(number, 10 - number, 'switchboard', stage) as LandedPullRequest,
        read: prRead(number, read),
    };
}

function lane(entries: LaneInput['entries'], overrides: Partial<LaneInput> = {}): LaneInput {
    return {entries, trunkOid: 'trunk-1', rules: RULES, mergeMethods: ['squash', 'merge'], now: NOW, ...overrides};
}

function memory(overrides: Partial<RunnerMemory> = {}): RunnerMemory {
    return {...EMPTY_MEMORY, ...overrides};
}

// ── Green ──

test('a head is green when GitHub can merge it and every required check passed on it', () => {
    /* Given */
    const green = prRead(1);
    const unstable = prRead(1, {
        mergeState: 'unstable',
        checks: [
            {name: 'Unit tests', state: 'passed', startedAt: NOW},
            {name: 'Optional lint', state: 'failed', startedAt: NOW},
        ],
    });
    const blocked = prRead(1, {mergeState: 'blocked'});
    const missing = prRead(1, {checks: [{name: 'Other', state: 'passed', startedAt: NOW}]});
    const running = prRead(1, {checks: [{name: 'Unit tests', state: 'running', startedAt: NOW}]});

    /* Then */
    assert.equal(isGreen(green, RULES), true);
    assert.equal(isGreen(unstable, RULES), true);
    assert.equal(isGreen(blocked, RULES), false);
    assert.equal(isGreen(missing, RULES), false);
    assert.equal(isGreen(running, RULES), false);
});

test('without required checks, every check that ran must have passed', () => {
    /* Given */
    const read = prRead(1, {
        checks: [
            {name: 'Unit tests', state: 'passed', startedAt: NOW},
            {name: 'Lint', state: 'running', startedAt: NOW},
        ],
    });

    /* Then */
    assert.equal(isGreen(read, NO_RULES), false);
    assert.equal(isGreen(prRead(1), NO_RULES), true);
});

// ── Merge method ──

test('the merge method is squash, else a merge commit, else rebase, as the repository and its rules allow', () => {
    /* Then */
    assert.equal(mergeMethod(['squash', 'merge', 'rebase'], RULES), 'squash');
    assert.equal(mergeMethod(['merge', 'rebase'], RULES), 'merge');
    assert.equal(mergeMethod(['squash', 'merge'], {...RULES, mergeMethods: ['merge', 'rebase']}), 'merge');
    assert.equal(mergeMethod(['merge', 'rebase'], {...RULES, linearHistory: true}), 'rebase');
    assert.equal(mergeMethod(['merge'], {...RULES, mergeMethods: ['squash']}), null);
});

// ── The head ──

test('a head behind the trunk is updated, pinned to its head commit', () => {
    /* Given */
    const input = lane([entry(1, head('updating'), {mergeState: 'behind'})]);

    /* When */
    const actions = laneActions(input, memory());

    /* Then */
    assert.deepEqual(actions, [{kind: 'update', key: 'movelab/connect#1', pullRequestId: 'PR_1', headOid: 'oid-1'}]);
});

test('a head is updated once per commit, and asked again only when GitHub did not move it in time', () => {
    /* Given */
    const input = lane([entry(1, head('updating'), {mergeState: 'behind'})]);
    const asked = memory({updated: new Map([['movelab/connect#1', {headOid: 'oid-1', at: NOW - MIN}]])});
    const longAgo = memory({
        updated: new Map([['movelab/connect#1', {headOid: 'oid-1', at: NOW - UPDATE_PATIENCE_MS}]]),
    });

    /* Then */
    assert.deepEqual(laneActions(input, asked), []);
    assert.equal(laneActions(input, longAgo)[0]?.kind, 'update');
});

test('an up-to-date head whose required run was cancelled gets that run started again, not an update', () => {
    /* Given */
    const input = lane([
        entry(1, head('updating'), {
            checks: [{name: 'Unit tests', state: 'cancelled', startedAt: NOW}],
            runs: [{id: 77, state: 'cancelled'}],
        }),
    ]);

    /* When */
    const actions = laneActions(input, memory());

    /* Then */
    assert.deepEqual(actions, [{kind: 'rerun', key: 'movelab/connect#1', runIds: [77]}]);
});

test('a green head is merged at its head commit with the first allowed method', () => {
    /* Given */
    const input = lane([entry(1, head('merging'))], {mergeMethods: ['merge', 'rebase']});

    /* When */
    const actions = laneActions(input, memory());

    /* Then */
    assert.deepEqual(actions, [{kind: 'merge', key: 'movelab/connect#1', number: 1, sha: 'oid-1', method: 'merge'}]);
});

test('a head whose checks run, or that GitHub has not judged yet, is left to wait', () => {
    /* Given */
    const checking = lane([entry(1, head('checks'))]);
    const unknown = lane([entry(1, head('merging'), {mergeState: 'unknown'})]);

    /* Then */
    assert.deepEqual(laneActions(checking, memory()), []);
    assert.deepEqual(laneActions(unknown, memory()), []);
});

test('a green head no merge method is allowed for needs you', () => {
    /* Given */
    const input = lane([entry(1, head('merging'))], {mergeMethods: ['merge'], rules: {...RULES, linearHistory: true}});

    /* When */
    const [action] = laneActions(input, memory());

    /* Then */
    assert.equal(action.kind, 'needsYou');
});

// ── Behind the head ──

test('the unfinished runs of PRs waiting behind the head are cancelled; held PRs and finished runs are left', () => {
    /* Given */
    const input = lane([
        entry(1, head('checks'), {runs: [{id: 11, state: 'unfinished'}]}),
        entry(2, WAITING, {
            runs: [
                {id: 21, state: 'unfinished'},
                {id: 22, state: 'finished'},
            ],
        }),
        entry(3, {kind: 'held', reason: {kind: 'approval'}}, {runs: [{id: 31, state: 'unfinished'}]}),
    ]);

    /* When */
    const actions = laneActions(input, memory());

    /* Then */
    assert.deepEqual(actions, [{kind: 'cancel', key: 'movelab/connect#2', runId: 21, force: false}]);
});

test('a run still going after it was cancelled is force-cancelled once', () => {
    /* Given */
    const input = lane([entry(1, head('checks')), entry(2, WAITING, {runs: [{id: 21, state: 'unfinished'}]})]);
    const justNow = memory({cancelled: new Map([[21, {at: NOW - MIN, forced: false}]])});
    const earlier = memory({cancelled: new Map([[21, {at: NOW - FORCE_CANCEL_AFTER_MS, forced: false}]])});
    const forced = memory({cancelled: new Map([[21, {at: NOW - FORCE_CANCEL_AFTER_MS, forced: true}]])});

    /* Then */
    assert.deepEqual(laneActions(input, justNow), []);
    assert.deepEqual(laneActions(input, earlier), [{kind: 'cancel', key: 'movelab/connect#2', runId: 21, force: true}]);
    assert.deepEqual(laneActions(input, forced), []);
});

test('the runs a fix errand started again on a waiting PR are not cancelled, until its head moves', () => {
    /* Given */
    const input = lane([entry(1, head('checks')), entry(2, WAITING, {runs: [{id: 21, state: 'unfinished'}]})]);
    const spared = memory({spared: new Map([['movelab/connect#2', 'oid-2']])});
    const pushedSince = memory({spared: new Map([['movelab/connect#2', 'oid-2-old']])});

    /* Then */
    assert.deepEqual(laneActions(input, spared), []);
    assert.equal(laneActions(input, pushedSince)[0]?.kind, 'cancel');
});

test('nothing is cancelled in a lane without a head', () => {
    /* Given */
    const input = lane([entry(2, WAITING, {runs: [{id: 21, state: 'unfinished'}]})]);

    /* Then */
    assert.deepEqual(laneActions(input, memory()), []);
});

test('a waiting PR GitHub calls dirty is test-rebased once per head and trunk commit, and never updated', () => {
    /* Given */
    const input = lane([entry(1, head('checks')), entry(2, WAITING, {mergeState: 'dirty', headRef: 'feature'})]);
    const tested = memory({
        testRebases: new Map([
            ['movelab/connect#2', {headOid: 'oid-2', trunkOid: 'trunk-1', conflict: true, files: ['a.ts']}],
        ]),
    });
    const trunkMoved = lane(input.entries, {trunkOid: 'trunk-2'});

    /* Then */
    assert.deepEqual(laneActions(input, memory()), [
        {kind: 'testRebase', key: 'movelab/connect#2', branch: 'feature', headOid: 'oid-2'},
    ]);
    assert.deepEqual(laneActions(input, tested), []);
    assert.equal(laneActions(trunkMoved, tested)[0]?.kind, 'testRebase');
});

// ── What the answers lead to ──

test('after a merge: merged or 409 reads again, 405 updates again, GitHub out of reach waits, else needs you', () => {
    /* Then */
    assert.deepEqual(afterMerge({ok: true}), {kind: 'reread'});
    assert.deepEqual(afterMerge({ok: false, status: 409, reason: 'Head branch was modified'}), {kind: 'reread'});
    assert.deepEqual(afterMerge({ok: false, status: 405, reason: 'Pull Request is not mergeable'}), {kind: 'update'});
    assert.deepEqual(afterMerge({ok: false, status: null, reason: 'GitHub did not answer'}), {kind: 'wait'});
    assert.deepEqual(afterMerge({ok: false, status: 502, reason: 'Bad gateway'}), {kind: 'wait'});
    assert.deepEqual(afterMerge({ok: false, status: 422, reason: 'Merge commits are not allowed'}), {
        kind: 'needsYou',
        reason: {kind: 'merge-refused', reason: 'Merge commits are not allowed'},
    });
});

test('after an update: a conflict is Fixing, a moved head reads again, a refusal needs you', () => {
    /* Then */
    assert.deepEqual(afterUpdate({ok: true}), {kind: 'wait'});
    assert.deepEqual(afterUpdate({ok: false, why: 'conflict', reason: 'conflicts'}), {
        kind: 'fixing',
        cause: 'conflict',
    });
    assert.deepEqual(afterUpdate({ok: false, why: 'moved', reason: 'expected head'}), {kind: 'reread'});
    assert.deepEqual(afterUpdate({ok: false, why: 'unavailable', reason: 'GitHub did not answer'}), {kind: 'wait'});
    assert.equal(afterUpdate({ok: false, why: 'refused', reason: 'Forbidden'}).kind, 'needsYou');
});

// ── Savings ──

test('when the trunk moves, every PR waiting behind the head counts as an update not pushed', () => {
    /* Given */
    const entries = [
        entry(1, head('checks')),
        entry(2, WAITING),
        entry(3, WAITING),
        entry(4, {kind: 'held', reason: {kind: 'approval'}}),
    ];

    /* Then */
    assert.equal(updatesNotPushed('trunk-1', 'trunk-2', entries), 2);
    assert.equal(updatesNotPushed('trunk-1', 'trunk-1', entries), 0);
    assert.equal(updatesNotPushed(null, 'trunk-2', entries), 0);
});
