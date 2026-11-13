/**
 * Where an item being worked on stands (#414): its stage from the session and
 * its branch's PR, through CI, review and the merge queue, and the two ends.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stageLabel, wantsYou, workProgress} from '../src/domain/inbox/stage';
import type {WorkPullRequest} from '../src/domain/inbox/stage';

function pr(overrides: Partial<WorkPullRequest> = {}): WorkPullRequest {
    return {state: 'open', checks: 'pending', queuePosition: null, ...overrides};
}

test('a running session without a PR is working', () => {
    /* Then */
    assert.deepEqual(workProgress('running', null), {kind: 'stage', stage: 'working'});
});

test('a session waiting on you without a PR needs you', () => {
    /* Then */
    assert.deepEqual(workProgress('needsYou', null), {kind: 'stage', stage: 'needsYou'});
});

test('a session that ended without a PR ends the work as tried', () => {
    /* Then */
    assert.deepEqual(workProgress('ended', null), {kind: 'noPr'});
});

test('a PR closed unmerged after the session ended counts as no PR', () => {
    /* Then */
    assert.deepEqual(workProgress('ended', pr({state: 'closed'})), {kind: 'noPr'});
});

test('an open PR with running checks is PR · CI, whether or not the session still runs', () => {
    /* Then */
    assert.deepEqual(workProgress('running', pr()), {kind: 'stage', stage: 'prCi'});
    assert.deepEqual(workProgress('ended', pr({state: 'draft'})), {kind: 'stage', stage: 'prCi'});
});

test('a failing check is CI failing', () => {
    /* Then */
    assert.deepEqual(workProgress('ended', pr({checks: 'failing'})), {kind: 'stage', stage: 'ciFailing'});
});

test('passing checks, or none, are ready', () => {
    /* Then */
    assert.deepEqual(workProgress('ended', pr({checks: 'passing'})), {kind: 'stage', stage: 'ready'});
    assert.deepEqual(workProgress('running', pr({checks: 'none'})), {kind: 'stage', stage: 'ready'});
});

test('a session asking a question on an open PR needs you before its checks', () => {
    /* Then */
    assert.deepEqual(workProgress('needsYou', pr({checks: 'failing'})), {kind: 'stage', stage: 'needsYou'});
});

test('a queued PR is in the queue, whatever its checks', () => {
    /* Then */
    assert.deepEqual(workProgress('ended', pr({queuePosition: 2, checks: 'failing'})), {kind: 'stage', stage: 'queue'});
});

test('a merged PR ends the work as merged', () => {
    /* Then */
    assert.deepEqual(workProgress('running', pr({state: 'merged'})), {kind: 'merged'});
});

test('only Needs you and CI failing want you', () => {
    /* Then */
    assert.deepEqual(
        (['working', 'needsYou', 'prCi', 'ciFailing', 'ready', 'queue', 'merged'] as const).filter(wantsYou),
        ['needsYou', 'ciFailing'],
    );
});

test("the queue's pill names the place", () => {
    /* Then */
    assert.equal(stageLabel('queue', 2), 'Queue · 2nd');
    assert.equal(stageLabel('queue', 11), 'Queue · 11th');
    assert.equal(stageLabel('queue'), 'Queue');
    assert.equal(stageLabel('prCi'), 'PR · CI');
});
