import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    IDLE,
    MIN_COMMIT_PX,
    claimsWheel,
    commitDistanceFor,
    feedSwipe,
    ignoreStream,
    releaseSwipe,
    startsStream,
    swipeArmed,
    swipeOffset,
} from '../src/domain/gesture/trackpad-swipe';
import type {SwipeState, WheelSample} from '../src/domain/gesture/trackpad-swipe';

/** One frame of a 60 Hz trackpad, the rate macOS sends wheel events at while the fingers move. */
const FRAME = 16;

/** A recorded stream: one sample per frame from `start`, with these deltas. */
function stream(deltas: readonly [dx: number, dy: number][], start = 0): WheelSample[] {
    return deltas.map(([dx, dy], i) => ({dx, dy, t: start + i * FRAME}));
}

/** The same delta `count` times. */
const repeat = (count: number, dx: number, dy = 0): [number, number][] => Array.from({length: count}, () => [dx, dy]);

/** Every state the recognizer passes through, from `from`. */
function play(samples: readonly WheelSample[], from: SwipeState = IDLE, commitDistance = MIN_COMMIT_PX): SwipeState[] {
    const states: SwipeState[] = [];
    let state = from;
    for (const sample of samples) {
        state = feedSwipe(state, sample, commitDistance);
        states.push(state);
    }
    return states;
}

const last = (states: readonly SwipeState[]): SwipeState => states[states.length - 1]!;

// ── Swipes ──

test('a clean swipe left past the threshold commits left at release', () => {
    /* Given: fingers moving left send a positive deltaX, 10 px a frame for 12 frames */
    const swipe = stream(repeat(12, 10));

    /* When */
    const tracked = last(play(swipe));
    const released = releaseSwipe(tracked);

    /* Then */
    assert.equal(tracked.phase, 'tracking');
    assert.equal(swipeOffset(tracked), -120);
    assert.deepEqual(released.phase === 'committed' && released.direction, 'left');
});

test('a clean swipe right commits right', () => {
    /* Given */
    const swipe = stream(repeat(12, -10, 1));

    /* When */
    const released = releaseSwipe(last(play(swipe)));

    /* Then */
    assert.deepEqual(released.phase === 'committed' && released.direction, 'right');
});

test('the row follows the fingers while tracking', () => {
    /* Given */
    const swipe = stream([
        [3, 0],
        [6, 0],
        [9, 1],
        [-4, 0],
    ]);

    /* When */
    const offsets = play(swipe).map(swipeOffset);

    /* Then: the first 3 px only start deciding, and the offset includes them once locked */
    assert.deepEqual(offsets, [0, -9, -18, -14]);
});

test('a short swipe cancels and reports its offset back to 0', () => {
    /* Given: 30 px, slowly */
    const swipe = stream(repeat(10, -3));

    /* When */
    const tracked = last(play(swipe));
    const released = releaseSwipe(tracked);

    /* Then */
    assert.equal(swipeOffset(tracked), 30);
    assert.deepEqual(released.phase === 'cancelled' && released.reason, 'short');
    assert.equal(swipeOffset(released), 0);
});

test('the swipe is released by a quiet gap, without being told', () => {
    /* Given: a long enough swipe, then the next sample 200 ms after it */
    const swipe = stream(repeat(10, 10));
    const later: WheelSample = {dx: 0.5, dy: 0, t: swipe[swipe.length - 1]!.t + 200};

    /* When */
    const state = last(play([...swipe, later]));

    /* Then: the gap released it, and the small sample after is its momentum */
    assert.deepEqual(state.phase === 'committed' && state.direction, 'left');
});

test('a flick commits short of the distance', () => {
    /* Given: a row 400 px wide wants 120 px, and three fast frames travel 90 */
    const flick = stream(repeat(3, -30));

    /* When */
    const released = releaseSwipe(last(play(flick, IDLE, commitDistanceFor(400))));

    /* Then */
    assert.deepEqual(released.phase === 'committed' && released.direction, 'right');
});

test('the same distance travelled slowly is no flick', () => {
    /* Given: 90 px over 30 frames */
    const slow = stream(repeat(30, -3));

    /* When */
    const released = releaseSwipe(last(play(slow, IDLE, commitDistanceFor(400))));

    /* Then */
    assert.equal(released.phase, 'cancelled');
});

test('a swipe that stops before lifting is no flick', () => {
    /* Given: three fast frames, a pause with the fingers resting, then a sliver */
    const flick = stream(repeat(3, -30));
    const rest: WheelSample = {dx: -1, dy: 0, t: flick[2]!.t + 70};

    /* When */
    const released = releaseSwipe(last(play([...flick, rest], IDLE, commitDistanceFor(400))));

    /* Then */
    assert.equal(released.phase, 'cancelled');
});

test('a swipe is armed once it has travelled far enough to commit', () => {
    /* Given */
    const swipe = stream(repeat(8, 10));

    /* When */
    const armed = play(swipe).map(swipeArmed);

    /* Then: 60 px is reached on the sixth frame */
    assert.deepEqual(armed, [false, false, false, false, false, true, true, true]);
});

test('the commit distance is a share of the width, with a floor', () => {
    /* When */
    const narrow = commitDistanceFor(100);
    const wide = commitDistanceFor(400);

    /* Then */
    assert.equal(narrow, MIN_COMMIT_PX);
    assert.equal(wide, 120);
});

// ── Scrolls ──

test('a vertical scroll with sideways drift never commits', () => {
    /* Given: a scroll that drifts sideways more and more */
    const scroll = stream([
        [1, 6],
        [2, 6],
        [6, 4],
        [12, 2],
        [20, 0],
        [20, 0],
        [20, 0],
        [20, 0],
    ]);

    /* When */
    const states = play(scroll);
    const released = releaseSwipe(last(states));

    /* Then */
    assert.ok(states.every((state) => state.phase !== 'tracking'));
    assert.deepEqual(released.phase === 'cancelled' && released.reason, 'vertical');
});

test('a diagonal is a scroll, not a swipe', () => {
    /* Given: 45 degrees */
    const diagonal = stream(repeat(6, 5, 5));

    /* When */
    const state = last(play(diagonal));

    /* Then */
    assert.deepEqual(state.phase === 'cancelled' && state.reason, 'vertical');
});

test('vertical wheel events are never claimed', () => {
    /* Given */
    const scroll = stream([...repeat(10, 0, 8), ...repeat(10, 3, 8)]);

    /* When */
    const claimed = play(scroll).map(claimsWheel);

    /* Then */
    assert.ok(claimed.every((c) => !c));
});

test('a swipe is claimed from the moment it locks horizontal, not before', () => {
    /* Given */
    const swipe = stream(repeat(4, 4));

    /* When */
    const claimed = play(swipe).map(claimsWheel);

    /* Then */
    assert.deepEqual(claimed, [false, true, true, true]);
});

// ── Momentum ──

test('the momentum tail after a commit does not start a second swipe', () => {
    /* Given: a swipe that commits, then macOS's decaying momentum after a gap */
    const swipe = stream(repeat(10, 12));
    const momentum = stream(
        [
            [9, 0],
            [7, 0],
            [5, 0],
            [4, 0],
            [3, 0],
            [2, 0],
            [1, 0],
            [1, 0],
            [0.5, 0],
        ],
        swipe[9]!.t + 100,
    );

    /* When */
    const committed = releaseSwipe(last(play(swipe)));
    const after = play(momentum, committed);

    /* Then */
    assert.equal(committed.phase, 'committed');
    assert.ok(after.every((state) => state.phase === 'committed'));
    assert.ok(after.every(claimsWheel), 'the momentum is not left to scroll anything either');
});

test('a scroll that started the stream swallows its momentum too', () => {
    /* Given */
    const scroll = stream(repeat(10, 0, 12));
    const momentum = stream(
        [
            [6, 6],
            [5, 4],
            [4, 2],
            [3, 1],
            [2, 0],
            [1, 0],
        ],
        scroll[9]!.t + 90,
    );

    /* When */
    const after = play(momentum, last(play(scroll)));

    /* Then */
    assert.ok(after.every((state) => state.phase === 'cancelled' && !claimsWheel(state)));
});

test('a new swipe starts once the momentum has gone quiet', () => {
    /* Given: a committed swipe, its momentum, then a pause */
    const swipe = stream(repeat(10, 12));
    const momentum = stream(repeat(5, 2), swipe[9]!.t + 100);
    const next = stream(repeat(10, -10), momentum[4]!.t + 300);

    /* When */
    const settled = last(play(momentum, releaseSwipe(last(play(swipe)))));
    const fresh = last(play(next, settled));

    /* Then */
    assert.equal(startsStream(settled, next[0]!), true);
    assert.equal(fresh.phase, 'tracking');
    assert.equal(swipeOffset(fresh), 100);
});

test('a harder push straight after the momentum is a new swipe', () => {
    /* Given: decayed momentum, then 120 ms later a firm push */
    const committed = releaseSwipe(last(play(stream(repeat(10, 12)))));
    const momentum = stream(repeat(3, 1), 300);
    const tailEnd = last(play(momentum, committed));
    const push: WheelSample = {dx: -9, dy: 0, t: momentum[2]!.t + 120};

    /* When */
    const starts = startsStream(tailEnd, push);

    /* Then */
    assert.equal(starts, true);
});

// ── Ignored streams ──

test('an ignored stream is swallowed whole and never claimed', () => {
    /* Given: the caller ignores a stream from its first sample */
    const swipe = stream(repeat(12, 10));
    const ignored = ignoreStream(swipe[0]!);

    /* When */
    const states = play(swipe.slice(1), ignored);

    /* Then */
    assert.ok(states.every((state) => state.phase === 'cancelled' && !claimsWheel(state)));
});

test('a touch too small to decide anything leaves the recognizer idle', () => {
    /* Given */
    const nudge = stream([[2, 1]]);

    /* When */
    const released = releaseSwipe(last(play(nudge)));

    /* Then */
    assert.equal(released.phase, 'idle');
});

test('one big wheel notch, as a tilt wheel or Shift with a mouse wheel sends, never commits', () => {
    /* Given: a single sideways event far past the threshold */
    const notch = stream([[100, 0]]);

    /* When */
    const released = releaseSwipe(last(play(notch)));

    /* Then */
    assert.deepEqual(released.phase === 'cancelled' && released.reason, 'short');
});

test('two fast notches are still too few samples to commit', () => {
    /* Given */
    const notches = stream([
        [60, 0],
        [60, 0],
    ]);

    /* When */
    const released = releaseSwipe(last(play(notches)));

    /* Then */
    assert.equal(released.phase, 'cancelled');
});
