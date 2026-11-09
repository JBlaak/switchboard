/**
 * A two-finger trackpad swipe, read from wheel events (#375).
 *
 * macOS hands the page no swipe events. A swipe arrives as a run of wheel
 * events with `deltaX`/`deltaY`, then, after the fingers lift, more wheel
 * events that decay (momentum), and never an "ended" event. This turns that
 * stream into a gesture:
 *
 *     idle ─▶ deciding ─▶ tracking {offset} ─▶ committed {direction}
 *                 │                        └─▶ cancelled
 *                 └─▶ cancelled (vertical)
 *
 * - The first few px of travel lock the direction. Mostly vertical (or
 *   diagonal) is a scroll: the stream is `cancelled` until it ends, so a
 *   scroll that drifts sideways later never becomes a swipe.
 * - A quiet gap with no samples is the release. At release the swipe commits
 *   when it travelled far enough, or when it was still moving fast (a flick).
 * - After a stream ends, decaying samples that follow are its momentum tail:
 *   they are swallowed, and only a sample after a longer quiet gap, or one
 *   that pushes harder than the tail, starts a new swipe.
 *
 * Offsets follow the fingers, with macOS's natural scrolling (the default):
 * fingers moving left send a positive `deltaX`, so the offset is the negated
 * sum of `dx`, negative for a swipe to the left.
 *
 * Pure: samples in, a state out. The renderer's hook owns the clock and the
 * timer that calls `releaseSwipe` when the gap has passed.
 */

/** One wheel event, in CSS px, at `t` ms (any monotonic clock). */
export interface WheelSample {
    readonly dx: number;
    readonly dy: number;
    readonly t: number;
}

export type SwipeDirection = 'left' | 'right';

/** How a stream that did not commit ended: a scroll, a swipe too short, or one the caller chose to ignore. */
export type CancelReason = 'vertical' | 'short' | 'ignored';

/** The last sample of an ended stream, which decides what counts as its momentum. */
interface Tail {
    readonly lastT: number;
    readonly lastSize: number;
}

export type SwipeState =
    | {readonly phase: 'idle'}
    /** Travelling, but not far enough yet to say which way. */
    | {
          readonly phase: 'deciding';
          readonly dx: number;
          readonly dy: number;
          readonly commitDistance: number;
          readonly tail: Tail;
      }
    /** Locked horizontal and following the fingers. */
    | {
          readonly phase: 'tracking';
          readonly axis: 'horizontal';
          readonly offset: number;
          readonly commitDistance: number;
          /** The samples of the last `VELOCITY_WINDOW_MS`, for the speed at release. */
          readonly recent: readonly WheelSample[];
          /** How many samples arrived since the lock, so one big wheel notch is never a swipe. */
          readonly samples: number;
          readonly tail: Tail;
      }
    | {readonly phase: 'committed'; readonly direction: SwipeDirection; readonly tail: Tail}
    | {readonly phase: 'cancelled'; readonly reason: CancelReason; readonly tail: Tail};

/** Travel, in px, after which the direction is locked: enough to tell a swipe from a scroll's first wobble. */
export const LOCK_DISTANCE_PX = 8;

/**
 * How much more sideways than vertical the locking travel must be to be a
 * swipe. Anything less, a 45° diagonal included, is a scroll: up and down
 * always wins.
 */
export const HORIZONTAL_DOMINANCE = 1.5;

/** No sample for this long, in ms, is the fingers lifting: macOS sends a wheel event every frame while they move. */
export const RELEASE_GAP_MS = 80;

/**
 * How long, in ms, after an ended stream a decaying sample still counts as its
 * momentum. A quiet gap longer than this always starts afresh.
 */
export const MOMENTUM_GAP_MS = 250;

/**
 * How much a momentum sample may exceed the one before it and still be
 * momentum (macOS's decay is not perfectly smooth); a harder push is a new
 * swipe. A ratio, plus `MOMENTUM_SLACK_PX` for the last, tiny samples.
 */
export const MOMENTUM_GROWTH = 1.2;

/**
 * Samples a locked stream needs before it can commit. A trackpad sends a
 * swipe as a run of small events; a mouse's tilt or thumb wheel, or Shift with
 * the wheel, sends one big event per notch, which would otherwise pass for a
 * flick and archive a row or switch session.
 */
export const MIN_SWIPE_SAMPLES = 3;
export const MOMENTUM_SLACK_PX = 1;

/** Share of the target's width a swipe must travel to commit, like a row dragged a third of the way across. */
export const COMMIT_SHARE = 0.3;

/** The least travel, in px, that commits a swipe, however narrow the target. */
export const MIN_COMMIT_PX = 60;

/** Speed at release, in px/ms, that commits a swipe short of the distance: a flick (1000 px/s). */
export const FLICK_SPEED = 1;

/** The least travel, in px, a flick needs, so a twitch at the start of a swipe is not one. */
export const FLICK_MIN_PX = 20;

/** The window, in ms, the release speed is measured over: the last few frames. */
export const VELOCITY_WINDOW_MS = 50;

export const IDLE: SwipeState = {phase: 'idle'};

/** The travel that commits a swipe on a target this many px wide. */
export function commitDistanceFor(width: number): number {
    return Math.max(MIN_COMMIT_PX, width * COMMIT_SHARE);
}

const size = (sample: WheelSample): number => Math.hypot(sample.dx, sample.dy);

const tailOf = (sample: WheelSample): Tail => ({lastT: sample.t, lastSize: size(sample)});

/** The quiet time before `t` since the stream's last sample. */
function gapBefore(state: SwipeState, t: number): number {
    return state.phase === 'idle' ? Infinity : t - state.tail.lastT;
}

/**
 * Whether this sample begins a new stream rather than continuing (or being
 * the momentum of) the current one. The hook asks this to decide whether a
 * stream should be ignored, from where it starts.
 */
export function startsStream(state: SwipeState, sample: WheelSample): boolean {
    const settled = state.phase === 'idle' ? state : releaseIfQuiet(state, sample.t);
    if (settled.phase === 'idle') return true;
    if (settled.phase === 'deciding' || settled.phase === 'tracking') return false;
    const gap = sample.t - settled.tail.lastT;
    if (gap < RELEASE_GAP_MS) return false;
    if (gap >= MOMENTUM_GAP_MS) return true;
    return size(sample) > settled.tail.lastSize * MOMENTUM_GROWTH + MOMENTUM_SLACK_PX;
}

/** A stream the caller does not want, swallowed whole like a scroll. */
export function ignoreStream(sample: WheelSample): SwipeState {
    return {phase: 'cancelled', reason: 'ignored', tail: tailOf(sample)};
}

/** The state after one more wheel sample. `commitDistance` applies to a stream this sample starts. */
export function feedSwipe(state: SwipeState, sample: WheelSample, commitDistance = MIN_COMMIT_PX): SwipeState {
    if (startsStream(state, sample)) return decide(sample.dx, sample.dy, commitDistance, sample);
    const current = releaseIfQuiet(state, sample.t);
    switch (current.phase) {
        case 'idle':
            return decide(sample.dx, sample.dy, commitDistance, sample);
        case 'deciding':
            return decide(current.dx + sample.dx, current.dy + sample.dy, current.commitDistance, sample);
        case 'tracking':
            return {
                ...current,
                offset: current.offset - sample.dx,
                recent: [...current.recent, sample].filter((s) => s.t > sample.t - VELOCITY_WINDOW_MS),
                samples: current.samples + 1,
                tail: tailOf(sample),
            };
        case 'committed':
        case 'cancelled':
            // The rest of the stream, or its momentum: swallowed.
            return {...current, tail: tailOf(sample)};
    }
}

/** Lock the direction once the travel is long enough; until then, keep deciding. */
function decide(dx: number, dy: number, commitDistance: number, sample: WheelSample): SwipeState {
    const tail = tailOf(sample);
    if (Math.hypot(dx, dy) < LOCK_DISTANCE_PX) return {phase: 'deciding', dx, dy, commitDistance, tail};
    if (Math.abs(dx) <= Math.abs(dy) * HORIZONTAL_DOMINANCE) return {phase: 'cancelled', reason: 'vertical', tail};
    return {phase: 'tracking', axis: 'horizontal', offset: -dx, commitDistance, recent: [sample], samples: 1, tail};
}

/** Release the stream when the quiet gap before `t` is long enough; otherwise leave it be. */
function releaseIfQuiet(state: SwipeState, t: number): SwipeState {
    return gapBefore(state, t) >= RELEASE_GAP_MS ? releaseSwipe(state) : state;
}

/**
 * The fingers lifted: the quiet gap has passed. A tracking swipe commits or
 * cancels; a stream still deciding was a touch too small to mean anything.
 */
export function releaseSwipe(state: SwipeState): SwipeState {
    switch (state.phase) {
        case 'deciding':
            return IDLE;
        case 'tracking': {
            const direction: SwipeDirection = state.offset < 0 ? 'left' : 'right';
            const travel = Math.abs(state.offset);
            const speed = releaseSpeed(state);
            const flick =
                travel >= FLICK_MIN_PX &&
                Math.abs(speed) >= FLICK_SPEED &&
                Math.sign(speed) === Math.sign(state.offset);
            if (state.samples < MIN_SWIPE_SAMPLES) return {phase: 'cancelled', reason: 'short', tail: state.tail};
            if (travel >= state.commitDistance || flick) return {phase: 'committed', direction, tail: state.tail};
            return {phase: 'cancelled', reason: 'short', tail: state.tail};
        }
        default:
            return state;
    }
}

/** The offset's speed over the last frames, in px/ms, signed like the offset. */
function releaseSpeed(state: Extract<SwipeState, {phase: 'tracking'}>): number {
    const travel = state.recent.reduce((sum, sample) => sum - sample.dx, 0);
    return travel / VELOCITY_WINDOW_MS;
}

/** How far the target should sit from home: the offset while tracking, 0 otherwise. */
export function swipeOffset(state: SwipeState): number {
    return state.phase === 'tracking' ? state.offset : 0;
}

/** Whether letting go now would commit on distance alone: the moment to show the action as armed. */
export function swipeArmed(state: SwipeState): boolean {
    return state.phase === 'tracking' && Math.abs(state.offset) >= state.commitDistance;
}

/**
 * Whether the wheel events of this stream belong to the swipe, and should not
 * also scroll anything: once locked horizontal, through its momentum. A
 * vertical or ignored stream, or one still deciding, is never claimed.
 */
export function claimsWheel(state: SwipeState): boolean {
    switch (state.phase) {
        case 'tracking':
        case 'committed':
            return true;
        case 'cancelled':
            return state.reason === 'short';
        default:
            return false;
    }
}
