/**
 * The Merge manager on the family floor (#440, for #432): its pose and its
 * peach counter from the lanes, and what its bubble says.
 *
 * It always stands there, idle when nothing is landed. The pose follows the
 * lanes: Needs you while any landed PR needs the user (that is what it calls
 * them over for, so it wins), moving while any lane's head is being updated,
 * tested or merged, idle otherwise. The counter counts Needs you only; a busy
 * lane shows in the pose, not a number.
 *
 * The bubble says what merged lately ("#432 merged"), for a while after.
 */
import type {MergeManagerState} from './model';

/** Matches the Merge manager's states in @jblaak/patch; `remote` is a VM's (#442). */
export type MergeFigurePose = 'idle' | 'moving' | 'needsYou';

export interface MergeFigure {
    readonly pose: MergeFigurePose;
    /** Landed PRs that need the user. */
    readonly count: number;
}

/** How long the bubble keeps saying what merged. */
export const MERGED_BUBBLE_MS = 15 * 60_000;

export function mergeFigureOf(state: MergeManagerState): MergeFigure {
    const stages = state.lanes.flatMap((lane) => lane.pullRequests.map((pr) => pr.stage.kind));
    const needsYou = stages.filter((kind) => kind === 'needsYou').length;
    const pose: MergeFigurePose = needsYou > 0 ? 'needsYou' : stages.includes('head') ? 'moving' : 'idle';
    return {pose, count: needsYou};
}

/**
 * What the bubble says at `now`: the PRs that merged in the last
 * `MERGED_BUBBLE_MS`, latest first ("#432 merged", "#432 and #431 merged",
 * "3 merged"), or null when none did.
 */
export function mergedBubble(state: MergeManagerState, now: number): string | null {
    const merged = state.lanes
        .flatMap((lane) => lane.pullRequests)
        .flatMap((pr) => (pr.stage.kind === 'merged' ? [{number: pr.number, at: pr.stage.at}] : []))
        .filter((pr) => pr.at <= now && now - pr.at < MERGED_BUBBLE_MS)
        .sort((a, b) => b.at - a.at || b.number - a.number);
    if (merged.length === 0) return null;
    if (merged.length === 1) return `#${merged[0].number} merged`;
    if (merged.length === 2) return `#${merged[0].number} and #${merged[1].number} merged`;
    return `${merged.length} merged`;
}

/** When the bubble next changes on its own (the oldest recent merge ages out); null when it does not. */
export function mergedBubbleExpiry(state: MergeManagerState, now: number): number | null {
    const ends = state.lanes
        .flatMap((lane) => lane.pullRequests)
        .flatMap((pr) => (pr.stage.kind === 'merged' ? [pr.stage.at + MERGED_BUBBLE_MS] : []))
        .filter((end) => end > now);
    return ends.length > 0 ? Math.min(...ends) : null;
}
