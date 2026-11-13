/** The Merge manager's renderer slice (#434): the lanes as main pushed them last, and the Needs you count. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialMergeManagerState, mergeManagerReducer, needsYouCount} from '../src/renderer/state/merge-manager-slice';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {HEAD, landedPr} from './support/merge-manager-fixtures';

test('a push replaces the lanes, and the Needs you count follows it', () => {
    /* Given */
    const state = mergeManagerState(
        [
            landedPr(1, 30, 'switchboard', HEAD),
            landedPr(2, 10, 'switchboard', {kind: 'needsYou', reason: {kind: 'unresolved-thread'}}),
        ],
        new Map(),
    );

    /* When */
    const next = mergeManagerReducer(initialMergeManagerState, {type: 'mergeManagerChanged', state});

    /* Then */
    assert.equal(next.state, state);
    assert.equal(needsYouCount(initialMergeManagerState), 0);
    assert.equal(needsYouCount(next), 1);
});

test('any other event leaves the slice as it was', () => {
    /* When */
    const next = mergeManagerReducer(initialMergeManagerState, {type: 'sessionArchived', sessionId: 's1'});

    /* Then */
    assert.strictEqual(next, initialMergeManagerState);
});
