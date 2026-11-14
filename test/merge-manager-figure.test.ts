/** The Merge manager on the family floor (#440): its pose and Needs you counter from the lanes, and its bubble. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MERGED_BUBBLE_MS, mergeFigureOf, mergedBubble, mergedBubbleExpiry} from '../src/domain/merge-manager/figure';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {EMPTY_MERGE_MANAGER_STATE} from '../src/domain/merge-manager/model';
import type {LaneStage} from '../src/domain/merge-manager/model';
import {HEAD, MIN, NOW, landedPr} from './support/merge-manager-fixtures';

const WAITING: LaneStage = {kind: 'waiting', willConflict: false, position: null};
const NEEDS_YOU: LaneStage = {kind: 'needsYou', reason: {kind: 'changes-requested'}};
const merged = (minutesAgo: number): LaneStage => ({kind: 'merged', at: NOW - minutesAgo * MIN});

function lanes(...stages: LaneStage[]) {
    return mergeManagerState(
        stages.map((stage, index) => landedPr(index + 1, 60 - index, 'switchboard', stage)),
        new Map(),
    );
}

test('with nothing landed it stands idle, without a counter', () => {
    /* When */
    const figure = mergeFigureOf(EMPTY_MERGE_MANAGER_STATE);

    /* Then */
    assert.deepEqual(figure, {pose: 'idle', count: 0});
});

test('landed PRs that only wait or are held leave it idle', () => {
    /* When */
    const figure = mergeFigureOf(lanes(WAITING, {kind: 'held', reason: {kind: 'approval'}}));

    /* Then */
    assert.deepEqual(figure, {pose: 'idle', count: 0});
});

test('a head being updated, tested or merged sets it moving', () => {
    /* When */
    const figure = mergeFigureOf(lanes(HEAD, WAITING));

    /* Then */
    assert.deepEqual(figure, {pose: 'moving', count: 0});
});

test('Needs you wins over a moving lane, and the counter counts Needs you only', () => {
    /* When */
    const figure = mergeFigureOf(lanes(HEAD, NEEDS_YOU, WAITING, NEEDS_YOU, {kind: 'fixing', cause: 'checks'}));

    /* Then */
    assert.deepEqual(figure, {pose: 'needsYou', count: 2});
});

test('the bubble says what merged lately, latest first', () => {
    /* Given */
    const one = lanes(merged(2), WAITING);
    const two = lanes(merged(5), merged(1));
    const three = lanes(merged(1), merged(2), merged(3));

    /* Then */
    assert.equal(mergedBubble(one, NOW), '#1 merged');
    assert.equal(mergedBubble(two, NOW), '#2 and #1 merged');
    assert.equal(mergedBubble(three, NOW), '3 merged');
});

test('the bubble is quiet when nothing merged lately, and says when it goes quiet', () => {
    /* Given */
    const state = lanes(merged(MERGED_BUBBLE_MS / MIN + 1), merged(10), HEAD);

    /* Then */
    assert.equal(mergedBubble(state, NOW), '#2 merged');
    assert.equal(mergedBubbleExpiry(state, NOW), NOW - 10 * MIN + MERGED_BUBBLE_MS);
    assert.equal(mergedBubble(state, NOW + 6 * MIN), null);
    assert.equal(mergedBubble(lanes(HEAD), NOW), null);
    assert.equal(mergedBubbleExpiry(lanes(HEAD), NOW), null);
});

// ── While a VM merges (#442) ──

test('while a VM merges it takes its remote pose, still counting Needs you, and the bubble says what happened there', () => {
    /* Given */
    const base = lanes(NEEDS_YOU, merged(5));
    const state = {
        ...base,
        merging: {
            kind: 'vm' as const,
            vm: {key: 'dev@devbox:22', name: 'devbox'},
            since: NOW - 60 * MIN,
            warning: null,
            reachable: true,
            vms: [],
            summary: {
                vm: 'devbox',
                merged: [{key: 'a', repository: 'r/r', number: 2, title: 't', url: 'u'}],
                needsYou: [{key: 'b', repository: 'r/r', number: 1, title: 't', url: 'u', question: null}],
                running: [],
            },
        },
    };

    /* Then */
    assert.deepEqual(mergeFigureOf(state), {pose: 'remote', count: 1});
    assert.equal(mergedBubble(state, NOW), '1 merged · 1 needs you');
    assert.equal(mergedBubbleExpiry(state, NOW), null);
});
