/**
 * Paging with a sideways swipe (#377): from one session, or one question, to
 * the next.
 *
 * Content follows the fingers, so a swipe to the left brings in what comes
 * after and a swipe to the right what came before, as a page turns. Where
 * there is nothing that way, what is under the fingers gives a little and
 * springs back: a rubber band, which slows as it stretches and never passes
 * its limit.
 */
import {commitDistanceFor} from './trackpad-swipe';
import type {SwipeDirection} from './trackpad-swipe';

/** The step a swipe this way takes: on for a swipe left, back for a swipe right. */
export function swipeStep(direction: SwipeDirection): 1 | -1 {
    return direction === 'left' ? 1 : -1;
}

/**
 * The most travel, in px, a page needs to turn. A share of the width suits a
 * row, but Claude's pane or the question sheet is wide enough that a third of
 * it is more than a comfortable swipe.
 */
export const PAGE_COMMIT_PX = 240;

/** The travel that turns a page this many px wide. */
export function pageCommitDistance(width: number): number {
    return Math.min(commitDistanceFor(width), PAGE_COMMIT_PX);
}

/** The farthest, in px, something with nowhere to go gives under the fingers. */
export const RUBBER_BAND_PX = 32;

/**
 * How far something with nowhere to go moves for a swipe that has travelled
 * `offset` px: the same way, less and less the farther it goes, never as far
 * as `limit`.
 */
export function rubberBand(offset: number, limit = RUBBER_BAND_PX): number {
    if (offset === 0) return 0;
    const stretch = Math.abs(offset) / limit;
    return Math.sign(offset) * limit * (1 - 1 / (stretch / 2 + 1));
}

/**
 * How far into its travel a swipe is, from 0 at the start to 1 at the
 * distance that commits it, for something sliding in with it.
 */
export function swipeProgress(offset: number, commitDistance: number): number {
    if (commitDistance <= 0) return 1;
    return Math.min(1, Math.abs(offset) / commitDistance);
}
