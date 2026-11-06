/**
 * The banner over the grilling card's question: what a revision changed, or
 * that a queued send did not go.
 *
 * A revision's banner counts the questions it marks (changed, new) and the
 * ones it dropped. It steps aside once the user has had every marked question
 * in view, or dismissed it, and comes back for the next revision. Which
 * questions were seen, and whether it was dismissed, are kept per revision,
 * so a new revision starts clean.
 *
 * A revision that cancelled a queued send says so instead, and keeps saying it
 * until the user sends or queues again (main clears the `unsent` state then).
 */
import type {GrillView} from '../../../domain/grill/model';

/** What the user did about one revision's banner. */
export interface BannerSeen {
    /** The revision this is about; anything recorded for another one is stale. */
    revision: number;
    dismissed: boolean;
    /** Places of the questions the card has shown during this revision. */
    seen: readonly number[];
}

export type Banner = {kind: 'unsent'; text: string} | {kind: 'revised'; text: string};

export const UNSENT_TEXT = 'Not sent: Claude changed the round. Check the marked questions, then send again.';

/** The record for `revision`: `seen` itself when it is about it, a clean one otherwise. */
export function bannerSeenFor(seen: BannerSeen | null | undefined, revision: number): BannerSeen {
    return seen && seen.revision === revision ? seen : {revision, dismissed: false, seen: []};
}

/** `seen` with the question at `place` shown; the same object when it already was. */
export function withSeen(seen: BannerSeen, place: number): BannerSeen {
    return seen.seen.includes(place) ? seen : {...seen, seen: [...seen.seen, place]};
}

/** The banner to show, or null for none. */
export function bannerFor(
    view: Pick<GrillView, 'questions' | 'dropped' | 'revision' | 'send'>,
    seen: BannerSeen | null | undefined,
): Banner | null {
    if (view.send === 'unsent') return {kind: 'unsent', text: UNSENT_TEXT};
    if (view.revision === 0) return null;
    const mine = bannerSeenFor(seen, view.revision);
    if (mine.dismissed) return null;

    const marked = view.questions.flatMap((q, place) => (q.mark ? [place] : []));
    if (marked.length > 0 && marked.every((place) => mine.seen.includes(place))) return null;

    const changed = view.questions.filter((q) => q.mark === 'changed').length;
    const added = view.questions.filter((q) => q.mark === 'new').length;
    const parts = [
        changed && `${changed} changed`,
        added && `${added} new`,
        view.dropped && `${view.dropped} dropped`,
    ].filter((part): part is string => !!part);
    if (parts.length === 0) return null;
    return {kind: 'revised', text: `Claude revised the round: ${parts.join(', ')}.`};
}
