/**
 * The question under a sideways swipe on the question sheet or the grilling
 * card (#377): it gives a little under the fingers, as a rubber band, and
 * springs back when they lift. A committed swipe then moves to the next or
 * previous question with the sheet's own swap. Under reduced motion it stays
 * put.
 */
import {motion, reducedMotion} from '../../lib/motion/spring';
import {rubberBand} from '../../../domain/gesture/swipe-paging';

/** Follow a swipe that has travelled `offset` px. */
export function nudgeQuestion(el: HTMLElement | null, offset: number): void {
    if (!el || reducedMotion()) return;
    motion(el).x.set(rubberBand(offset));
}

/** Spring back from a swipe, committed or not. */
export function releaseQuestion(el: HTMLElement | null): void {
    if (el) motion(el).x.to(0);
}
