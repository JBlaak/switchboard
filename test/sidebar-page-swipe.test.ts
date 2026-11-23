import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    FLIP_PX,
    QUIET_AFTER_FLIP_MS,
    SETTLE_AFTER_MS,
    isDueToSettle,
    otherPage,
    restingSwipe,
    settleSwipe,
    swipeOffset,
    swipeProgress,
    swipeWheel,
    type Swipe,
    type WheelInput,
} from '../src/renderer/ui/sidebar-pages/swipe';

const WIDTH = 340;

/** The tracker after one sideways wheel per delta, each 10 ms after the last. */
function swiped(swipe: Swipe, deltas: number[], startAt = 1000): Swipe {
    return deltas.reduce((s, deltaX, i) => swipeWheel(s, {deltaX, deltaY: 0, at: startAt + i * 10}), swipe);
}

// ── Which wheel events count ──

test('a sideways wheel moves the pages with the fingers, one px for one px, left toward Pull requests', () => {
    /* Given */
    const swipe = restingSwipe('sessions');

    /* When */
    const after = swiped(swipe, [10, 15, 5]);

    /* Then */
    assert.equal(swipeOffset(after, WIDTH), -30);
});

test('a mostly vertical wheel is a scroll, and leaves the swipe alone', () => {
    /* Given */
    const swipe = restingSwipe('sessions');
    const scroll: WheelInput = {deltaX: 4, deltaY: 20, at: 1000};
    const tie: WheelInput = {deltaX: 10, deltaY: -10, at: 1010};

    /* When */
    const after = swipeWheel(swipeWheel(swipe, scroll), tie);

    /* Then */
    assert.equal(after, swipe);
});

test('in the quiet after a flip, the wheel is ignored, and counted again once it is over', () => {
    /* Given */
    const swipe = restingSwipe('pullRequests', 2000);

    /* When */
    const during = swipeWheel(swipe, {deltaX: -30, deltaY: 0, at: 1999});
    const after = swipeWheel(swipe, {deltaX: -30, deltaY: 0, at: 2000});

    /* Then */
    assert.equal(during, swipe);
    assert.equal(swipeOffset(after, WIDTH), 30);
});

// ── Rubber band ──

test('past the first page, the pages follow at three tenths', () => {
    /* Given */
    const swipe = restingSwipe('sessions');

    /* When */
    const after = swiped(swipe, [-50, -50]);

    /* Then */
    assert.equal(swipeOffset(after, WIDTH), 30);
});

test('past the last page, the pages follow at three tenths, both from the last page and from beyond the next', () => {
    /* Given */
    const onPullRequests = restingSwipe('pullRequests');
    const onSessions = restingSwipe('sessions');

    /* When */
    const pastLast = swiped(onPullRequests, [100]);
    const pastNext = swiped(onSessions, [WIDTH, 100]);

    /* Then */
    assert.equal(swipeOffset(pastLast, WIDTH), -30);
    assert.equal(swipeOffset(pastNext, WIDTH), -WIDTH - 30);
});

// ── Progress ──

test('the progress runs from 0 on Sessions to 1 on Pull requests, held on the track past either end', () => {
    /* Given */
    const halfway = swiped(restingSwipe('sessions'), [WIDTH / 2]);
    const pulledPastSessions = swiped(restingSwipe('sessions'), [-100]);
    const backFromPullRequests = swiped(restingSwipe('pullRequests'), [-WIDTH / 4]);

    /* When */
    const progress = [halfway, pulledPastSessions, backFromPullRequests].map((s) => swipeProgress(s, WIDTH));

    /* Then */
    assert.deepEqual(progress, [0.5, 0, 0.75]);
});

// ── Settling ──

test('a swipe settles once the wheel has been quiet for its settle time, and not before', () => {
    /* Given */
    const swipe = swiped(restingSwipe('sessions'), [20]);

    /* When */
    const early = isDueToSettle(swipe, 1000 + SETTLE_AFTER_MS - 1);
    const due = isDueToSettle(swipe, 1000 + SETTLE_AFTER_MS);
    const atRest = isDueToSettle(restingSwipe('sessions'), 99999);

    /* Then */
    assert.deepEqual([early, due, atRest], [false, true, false]);
});

test('past the flip distance a swipe left flips to Pull requests, and the wheel goes quiet', () => {
    /* Given */
    const swipe = swiped(restingSwipe('sessions'), [FLIP_PX]);

    /* When */
    const settled = settleSwipe(swipe, WIDTH, 5000);

    /* Then */
    assert.equal(settled.page, 'pullRequests');
    assert.equal(settled.flipped, true);
    assert.deepEqual(settled.swipe, restingSwipe('pullRequests', 5000 + QUIET_AFTER_FLIP_MS));
});

test('past the flip distance a swipe right flips back to Sessions', () => {
    /* Given */
    const swipe = swiped(restingSwipe('pullRequests'), [-40, -40]);

    /* When */
    const settled = settleSwipe(swipe, WIDTH, 5000);

    /* Then */
    assert.equal(settled.page, 'sessions');
    assert.equal(settled.flipped, true);
});

test('short of the flip distance a swipe springs back to the page it started on', () => {
    /* Given */
    const swipe = swiped(restingSwipe('sessions'), [FLIP_PX - 1]);

    /* When */
    const settled = settleSwipe(swipe, WIDTH, 5000);

    /* Then */
    assert.equal(settled.page, 'sessions');
    assert.equal(settled.flipped, false);
    assert.deepEqual(settled.swipe, restingSwipe('sessions'));
});

test('a rubber-banded pull past the first page springs back, however far it went', () => {
    /* Given */
    const swipe = swiped(restingSwipe('sessions'), [-400]);

    /* When */
    const settled = settleSwipe(swipe, WIDTH, 5000);

    /* Then */
    assert.equal(settled.page, 'sessions');
    assert.equal(settled.flipped, false);
});

// ── The other page ──

test('the other page of each page is the one beside it', () => {
    /* Given */
    const pages = ['sessions', 'pullRequests'] as const;

    /* When */
    const others = pages.map(otherPage);

    /* Then */
    assert.deepEqual(others, ['pullRequests', 'sessions']);
});
