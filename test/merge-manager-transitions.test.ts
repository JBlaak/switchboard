/** What a change to the landed PRs tells (#440): which merged, which went to Needs you, and when the Dock bounces. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bouncesDock, landedTransitions, NO_TRANSITIONS} from '../src/domain/merge-manager/transitions';
import type {LandedPullRequest, LaneStage} from '../src/domain/merge-manager/model';
import {HEAD, NOW, landedPr} from './support/merge-manager-fixtures';

const NEEDS_YOU: LaneStage = {kind: 'needsYou', reason: {kind: 'unresolved-thread'}};
const MERGED: LaneStage = {kind: 'merged', at: NOW};

function known(...prs: LandedPullRequest[]): Map<string, LandedPullRequest> {
    return new Map(prs.map((pr) => [pr.key, pr]));
}

test('a PR that goes to Needs you bounces the Dock', () => {
    /* Given */
    const before = known(landedPr(1, 10, 'switchboard', HEAD));

    /* When */
    const transitions = landedTransitions(before, [landedPr(1, 10, 'switchboard', NEEDS_YOU)]);

    /* Then */
    assert.deepEqual(
        transitions.needsYou.map((pr) => pr.number),
        [1],
    );
    assert.equal(bouncesDock(transitions), true);
});

test('a PR that stays in Needs you does not bounce again', () => {
    /* Given */
    const before = known(landedPr(1, 10, 'switchboard', NEEDS_YOU));

    /* When */
    const transitions = landedTransitions(before, [
        landedPr(1, 10, 'switchboard', {kind: 'needsYou', reason: {kind: 'changes-requested'}}),
    ]);

    /* Then */
    assert.deepEqual(transitions.needsYou, []);
    assert.equal(bouncesDock(transitions), false);
});

test('a PR landed straight into Needs you goes there too', () => {
    /* When */
    const transitions = landedTransitions(known(), [landedPr(1, 0, 'queue', NEEDS_YOU)]);

    /* Then */
    assert.equal(bouncesDock(transitions), true);
});

test('a merge is told, but does not bounce the Dock', () => {
    /* Given */
    const before = known(landedPr(1, 10, 'switchboard', HEAD), landedPr(2, 5, 'switchboard', MERGED));

    /* When */
    const transitions = landedTransitions(before, [
        landedPr(1, 10, 'switchboard', MERGED),
        landedPr(2, 5, 'switchboard', MERGED),
    ]);

    /* Then */
    assert.deepEqual(
        transitions.merged.map((pr) => pr.number),
        [1],
    );
    assert.equal(bouncesDock(transitions), false);
    assert.equal(bouncesDock(NO_TRANSITIONS), false);
});
