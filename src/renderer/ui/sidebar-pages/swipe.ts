/**
 * The two-finger swipe across the sidebar, as arithmetic: fed the trackpad's
 * wheel events, it answers how far the pages have moved and which page they
 * settle on.
 *
 * A trackpad has no "swipe ended" event. Its horizontal scroll arrives as
 * wheel events, momentum included, and simply stops; so a swipe settles once
 * the wheel has been quiet for a moment. Kept free of the DOM and the clock
 * (every event carries its own time) so all of it is tested in node; the
 * listener and the timers live in `install-sidebar-pages`.
 *
 * Offsets are in pixels, negative to the left. Swiping left (the fingers
 * moving left, positive deltaX) moves the pages left: Sessions → Pull requests.
 */
import type {SidebarPage} from '../../state/sidebar-page-slice';

/** How far, in px, the pages have to have moved for a swipe to flip the page. */
export const FLIP_PX = 70;

/** How long the wheel has to be quiet before a swipe settles. */
export const SETTLE_AFTER_MS = 130;

/** After a flip, the wheel is ignored this long, so the trackpad's momentum does not bounce it back. */
export const QUIET_AFTER_FLIP_MS = 450;

/** Past the first or the last page, the pages follow the fingers at this fraction. */
export const RUBBER_BAND = 0.3;

/** The pages, left to right. */
export const PAGES: readonly SidebarPage[] = ['sessions', 'pullRequests'];

/** What the tracker reads of a wheel event. */
export interface WheelInput {
    readonly deltaX: number;
    readonly deltaY: number;
    /** When it happened, in ms on any clock the caller keeps to. */
    readonly at: number;
}

export interface Swipe {
    /** The page the pages rest on: where this swipe started from. */
    readonly page: SidebarPage;
    /** How far the fingers have gone, in px, negative to the left; 0 at rest. */
    readonly travel: number;
    /** When the last counted wheel event came; null while no swipe is in flight. */
    readonly lastAt: number | null;
    /** Wheel events before this time are ignored (the quiet after a flip). */
    readonly quietUntil: number;
}

/** The result of settling a swipe. */
export interface Settled {
    /** The page the pages settle on. */
    readonly page: SidebarPage;
    /** Whether that is the other page than the swipe started from. */
    readonly flipped: boolean;
    /** The tracker at rest again, on that page. */
    readonly swipe: Swipe;
}

/** A tracker at rest on `page`. */
export function restingSwipe(page: SidebarPage, quietUntil = 0): Swipe {
    return {page, travel: 0, lastAt: null, quietUntil};
}

/** Whether a wheel event is a sideways one: the only kind a swipe counts, so scrolling either list stays a scroll. */
export function isSidewaysWheel(input: Pick<WheelInput, 'deltaX' | 'deltaY'>): boolean {
    return Math.abs(input.deltaX) > Math.abs(input.deltaY);
}

/** The swipe after one more wheel event; the same swipe when the event does not count. */
export function swipeWheel(swipe: Swipe, input: WheelInput): Swipe {
    if (!isSidewaysWheel(input) || input.at < swipe.quietUntil) return swipe;
    return {...swipe, travel: swipe.travel - input.deltaX, lastAt: input.at};
}

/** Whether the wheel has been quiet long enough for a swipe in flight to settle. */
export function isDueToSettle(swipe: Swipe, now: number): boolean {
    return swipe.lastAt !== null && now - swipe.lastAt >= SETTLE_AFTER_MS;
}

/**
 * How far the pages have moved from where they rest, in px: the fingers' own
 * travel between the first and the last page, rubber-banded past them.
 */
export function swipeOffset(swipe: Swipe, width: number): number {
    const index = PAGES.indexOf(swipe.page);
    // From the page at `index`, the pages can move right as far as the first
    // page and left as far as the last.
    const furthestRight = index * width;
    const furthestLeft = -(PAGES.length - 1 - index) * width;
    if (swipe.travel > furthestRight) return furthestRight + (swipe.travel - furthestRight) * RUBBER_BAND;
    if (swipe.travel < furthestLeft) return furthestLeft + (swipe.travel - furthestLeft) * RUBBER_BAND;
    return swipe.travel;
}

/**
 * Where the pages are, as a fraction of the way from Sessions (0) to Pull
 * requests (1): what the switch's pill follows. Held between 0 and 1, so a
 * rubber band does not pull the pill off the track.
 */
export function swipeProgress(swipe: Swipe, width: number): number {
    if (width <= 0) return PAGES.indexOf(swipe.page);
    const progress = PAGES.indexOf(swipe.page) - swipeOffset(swipe, width) / width;
    return Math.min(PAGES.length - 1, Math.max(0, progress));
}

/**
 * Where a swipe comes to rest: past FLIP_PX toward the other page it flips
 * (and the wheel goes quiet for a moment), otherwise it springs back.
 */
export function settleSwipe(swipe: Swipe, width: number, now: number): Settled {
    const offset = swipeOffset(swipe, width);
    const index = PAGES.indexOf(swipe.page);
    const step = offset <= -FLIP_PX ? 1 : offset >= FLIP_PX ? -1 : 0;
    const target = PAGES[index + step];
    if (step === 0 || !target) {
        return {page: swipe.page, flipped: false, swipe: restingSwipe(swipe.page, swipe.quietUntil)};
    }
    return {page: target, flipped: true, swipe: restingSwipe(target, now + QUIET_AFTER_FLIP_MS)};
}

/** The other page: what the switch and Cmd+P flip to. */
export function otherPage(page: SidebarPage): SidebarPage {
    return page === 'sessions' ? 'pullRequests' : 'sessions';
}
