import {test} from 'node:test';
import assert from 'node:assert/strict';

import {MIN_COMMIT_PX, commitDistanceFor} from '../src/domain/gesture/trackpad-swipe';
import {
    PAGE_COMMIT_PX,
    RUBBER_BAND_PX,
    pageCommitDistance,
    rubberBand,
    swipeProgress,
    swipeStep,
} from '../src/domain/gesture/swipe-paging';

test('a swipe left goes on and a swipe right goes back', () => {
    /* Given */
    const directions = ['left', 'right'] as const;

    /* When */
    const steps = directions.map(swipeStep);

    /* Then */
    assert.deepEqual(steps, [1, -1]);
});

test('a rubber band follows the fingers the same way, less than they travel', () => {
    /* Given */
    const offsets = [-40, 40];

    /* When */
    const moved = offsets.map((offset) => rubberBand(offset));

    /* Then */
    assert.ok(moved[0] < 0 && moved[0] > -40);
    assert.ok(moved[1] > 0 && moved[1] < 40);
    assert.equal(moved[0], -moved[1]);
});

test('a rubber band gives less the farther it is pulled, and never reaches its limit', () => {
    /* Given */
    const offsets = [20, 60, 100, 2000];

    /* When */
    const moved = offsets.map((offset) => rubberBand(offset));

    /* Then */
    for (let i = 1; i < moved.length; i++) assert.ok(moved[i] > moved[i - 1]);
    assert.ok(moved[1] - moved[0] > moved[2] - moved[1]);
    assert.ok(moved[3] < RUBBER_BAND_PX);
});

test('a rubber band at rest does not move', () => {
    /* Given */
    const offset = 0;

    /* When */
    const moved = rubberBand(offset);

    /* Then */
    assert.equal(moved, 0);
});

test('the progress runs from 0 to 1 at the commit distance, either way, and stops there', () => {
    /* Given */
    const commitDistance = 100;

    /* When */
    const progress = [0, -50, 50, 100, -300].map((offset) => swipeProgress(offset, commitDistance));

    /* Then */
    assert.deepEqual(progress, [0, 0.5, 0.5, 1, 1]);
});

test('a narrow page turns at the share of its width a row needs', () => {
    /* Given */
    const widths = [100, 500];

    /* When */
    const distances = widths.map(pageCommitDistance);

    /* Then */
    assert.deepEqual(distances, [MIN_COMMIT_PX, commitDistanceFor(500)]);
});

test('a wide page turns at a comfortable swipe, not a third of its width', () => {
    /* Given */
    const width = 1500;

    /* When */
    const distance = pageCommitDistance(width);

    /* Then */
    assert.equal(distance, PAGE_COMMIT_PX);
    assert.ok(distance < commitDistanceFor(width));
});
