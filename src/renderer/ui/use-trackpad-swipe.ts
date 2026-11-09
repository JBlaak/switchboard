/**
 * A two-finger sideways trackpad swipe on an element (#375).
 *
 * Feeds the element's wheel events to the recognizer in
 * `domain/gesture/trackpad-swipe` and reports what it makes of them: the
 * offset while the swipe follows the fingers, then a commit with its
 * direction or a cancel. The recognizer cannot see the fingers lift, so a
 * timer releases the swipe once the wheel has been quiet for
 * `RELEASE_GAP_MS`.
 *
 * The listener is attached by hand because React's is passive, and a swipe
 * must stop the page scrolling sideways (and the browser's back swipe). Only
 * a stream locked horizontal is `preventDefault`ed: a vertical scroll, or one
 * still deciding, passes through untouched.
 *
 * `attachTrackpadSwipe` is the imperative form, for the parts of the renderer
 * that are not React (the terminal pane); `useTrackpadSwipe` attaches it to a
 * ref for the life of a component.
 */
import {useEffect, useRef} from 'react';
import {
    IDLE,
    RELEASE_GAP_MS,
    claimsWheel,
    commitDistanceFor,
    feedSwipe,
    ignoreStream,
    releaseSwipe,
    startsStream,
    swipeArmed,
} from '../../domain/gesture/trackpad-swipe';
import type {RefObject} from 'react';
import type {SwipeDirection, SwipeState, WheelSample} from '../../domain/gesture/trackpad-swipe';

export type {SwipeDirection} from '../../domain/gesture/trackpad-swipe';

export interface TrackpadSwipeOptions {
    /**
     * Each wheel event while the swipe follows the fingers: the offset in px
     * (negative to the left) and whether letting go now would commit.
     */
    onTrack?(offset: number, armed: boolean): void;
    /** The swipe went far or fast enough. Called once, at release. */
    onCommit(direction: SwipeDirection): void;
    /** A swipe that tracked ended short (or the element went away mid-swipe): put things back. */
    onCancel?(): void;
    /**
     * The travel, in px, that commits a swipe, read when a stream starts.
     * Defaults to a share of the element's width with a floor
     * (`commitDistanceFor`).
     */
    commitDistance?(el: HTMLElement): number;
    /**
     * Streams that start inside a descendant that scrolls sideways (a code
     * block, a wide table) are left to that descendant. True swipes there too.
     */
    swipeInsideHorizontalScrollers?: boolean;
    /** Any other stream to leave alone, judged by its first event. */
    ignore?(event: WheelEvent): boolean;
}

/** Pixels in a wheel "line", for a mouse that reports lines rather than pixels (as ImageStage). */
const LINE_PIXELS = 16;

/** Listen for swipes on `el`; answers the call that stops listening. */
export function attachTrackpadSwipe(el: HTMLElement, options: TrackpadSwipeOptions): () => void {
    let state: SwipeState = IDLE;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Move to `next`, telling the caller what changed for it. */
    const move = (next: SwipeState): void => {
        const previous = state;
        state = next;
        if (next.phase === 'tracking') options.onTrack?.(next.offset, swipeArmed(next));
        else if (previous.phase === 'tracking') {
            if (next.phase === 'committed') options.onCommit(next.direction);
            else options.onCancel?.();
        }
    };

    const release = (): void => {
        timer = null;
        move(releaseSwipe(state));
    };

    const ignored = (event: WheelEvent): boolean =>
        (options.ignore?.(event) ?? false) ||
        (!options.swipeInsideHorizontalScrollers && inHorizontalScroller(event.target, el));

    const onWheel = (event: WheelEvent): void => {
        // A pinch arrives as a wheel with ctrlKey, and ⌘-scroll zooms elsewhere: neither is a swipe.
        if (event.ctrlKey || event.metaKey) return;
        // Shift with a mouse wheel scrolls sideways, and line or page deltas only come from a
        // mouse wheel: a trackpad sends px without Shift. Neither is a swipe.
        if (event.shiftKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
        const sample = sampleOf(event, el);
        // A late sample after a quiet gap the timer has not caught yet releases first,
        // so the commit is never lost to the stream that follows.
        if (state.phase === 'tracking' && sample.t - state.tail.lastT >= RELEASE_GAP_MS) move(releaseSwipe(state));
        if (startsStream(state, sample) && ignored(event)) move(ignoreStream(sample));
        else move(feedSwipe(state, sample, (options.commitDistance ?? defaultCommitDistance)(el)));
        if (claimsWheel(state)) event.preventDefault();
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(release, RELEASE_GAP_MS);
    };

    el.addEventListener('wheel', onWheel, {passive: false});
    return () => {
        el.removeEventListener('wheel', onWheel);
        if (timer !== null) clearTimeout(timer);
        if (state.phase === 'tracking') options.onCancel?.();
        state = IDLE;
    };
}

/**
 * `attachTrackpadSwipe` on `ref`'s element while the component is mounted and
 * `enabled`. The options are read live, so passing new callbacks each render
 * does not re-attach.
 */
export function useTrackpadSwipe(
    ref: RefObject<HTMLElement | null>,
    options: TrackpadSwipeOptions,
    enabled = true,
): void {
    const latest = useRef(options);
    latest.current = options;

    useEffect(() => {
        const el = ref.current;
        if (!el || !enabled) return;
        // Every option is read through to the latest render's, since the listener reads them as it goes.
        const live = latest;
        return attachTrackpadSwipe(el, {
            get onTrack() {
                return live.current.onTrack;
            },
            get onCommit() {
                return live.current.onCommit;
            },
            get onCancel() {
                return live.current.onCancel;
            },
            get commitDistance() {
                return live.current.commitDistance;
            },
            get swipeInsideHorizontalScrollers() {
                return live.current.swipeInsideHorizontalScrollers;
            },
            get ignore() {
                return live.current.ignore;
            },
        });
    }, [ref, enabled]);
}

const defaultCommitDistance = (el: HTMLElement): number => commitDistanceFor(el.clientWidth);

/** The event's deltas in px, at its time. */
function sampleOf(event: WheelEvent, el: HTMLElement): WheelSample {
    const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? LINE_PIXELS
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? el.clientWidth
              : 1;
    return {dx: event.deltaX * scale, dy: event.deltaY * scale, t: event.timeStamp};
}

/** Whether `target` sits in something between it and `root` that scrolls sideways. */
function inHorizontalScroller(target: EventTarget | null, root: HTMLElement): boolean {
    for (let node = target instanceof Element ? target : null; node && node !== root; node = node.parentElement) {
        if (node.scrollWidth <= node.clientWidth) continue;
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') return true;
    }
    return false;
}
