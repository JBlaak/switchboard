/** The Merge manager's renderer slice (#434): the lanes as main pushed them last, the Needs you count, and Land it's toast (#436). */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    initialMergeManagerState,
    landBusy,
    mergeManagerReducer,
    needsYouCount,
    rekeyMergeManager,
    type MergeManagerSliceState,
} from '../src/renderer/state/merge-manager-slice';
import {landedView, mergeManagerState} from '../src/domain/merge-manager/landed';
import {landedKey} from '../src/domain/merge-manager/model';
import {HEAD, REPO, landedPr} from './support/merge-manager-fixtures';

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

// ── Land it (#436) ──

test("landing brings the toast with the PR's place in its lane, offering Undo", () => {
    /* Given */
    const state = mergeManagerState([landedPr(1, 30, 'switchboard', HEAD), landedPr(2, 10)], new Map());
    const landed = landedView(state, landedKey(REPO, 2));
    const busy = mergeManagerReducer(initialMergeManagerState, {
        type: 'landStarted',
        repository: REPO,
        number: 2,
        action: 'land',
    });

    /* When */
    const next = mergeManagerReducer(busy, {
        type: 'landFinished',
        repository: REPO,
        number: 2,
        action: 'land',
        result: {ok: true, landed},
    });

    /* Then */
    assert.equal(landBusy(busy, REPO, 2), 'land');
    assert.equal(landBusy(next, REPO, 2), null);
    assert.deepEqual(next.toast, {
        id: 1,
        kind: 'landed',
        text: "Landed #2 · 2nd in connect's lane",
        repository: REPO,
        number: 2,
    });
});

test('a land that main refused says why', () => {
    /* When */
    const next = mergeManagerReducer(initialMergeManagerState, {
        type: 'landFinished',
        repository: REPO,
        number: 7,
        action: 'land',
        result: {ok: false, reason: 'Mark it ready for review first'},
    });

    /* Then */
    assert.deepEqual(next.toast, {id: 1, kind: 'failed', text: 'Could not land #7: Mark it ready for review first'});
});

test("unlanding the PR the toast landed puts the toast away; another PR's leaves it", () => {
    /* Given */
    const toasted = mergeManagerReducer(initialMergeManagerState, {
        type: 'landFinished',
        repository: REPO,
        number: 2,
        action: 'land',
        result: {ok: true, landed: null},
    });
    const unland = (number: number) =>
        mergeManagerReducer(toasted, {
            type: 'landFinished',
            repository: REPO,
            number,
            action: 'unland',
            result: {ok: true, landed: null},
        });

    /* Then */
    assert.equal(toasted.toast?.text, 'Landed #2');
    assert.equal(unland(2).toast, null);
    assert.equal(unland(3).toast, toasted.toast);
});

test('closing an older toast leaves a newer one up', () => {
    /* Given */
    const finish = (state: MergeManagerSliceState, number: number) =>
        mergeManagerReducer(state, {
            type: 'landFinished',
            repository: REPO,
            number,
            action: 'land',
            result: {ok: true, landed: null},
        });
    const two = finish(finish(initialMergeManagerState, 1), 2);

    /* When */
    const stale = mergeManagerReducer(two, {type: 'landToastClosed', id: 1});
    const closed = mergeManagerReducer(two, {type: 'landToastClosed', id: 2});

    /* Then */
    assert.equal(stale.toast?.text, 'Landed #2');
    assert.equal(closed.toast, null);
});

test('a re-keyed session keeps its PRs for Land it', () => {
    /* Given */
    const loaded = mergeManagerReducer(initialMergeManagerState, {
        type: 'sessionPullRequestsLoaded',
        sessionId: 'old',
        pullRequests: [],
    });

    /* When */
    const next = rekeyMergeManager(loaded, 'old', 'new');

    /* Then */
    assert.deepEqual(Object.keys(next.sessionPullRequests), ['new']);
});
