/**
 * What a change to the landed PRs means for the user (#440, for #432): which
 * PRs just merged (their sessions are archived) and which just went to Needs
 * you (the Dock bounces once).
 *
 * A PR "goes to" a stage when it is at that stage after the change and was
 * not before it, so a PR that stays in Needs you across polls is told once,
 * and one that leaves and comes back is told again. A PR landed straight into
 * Needs you goes there too.
 */
import type {LandedPullRequest, LaneStageKind} from './model';

export interface LandedTransitions {
    /** PRs that merged in this change. */
    readonly merged: readonly LandedPullRequest[];
    /** PRs that went to Needs you in this change. */
    readonly needsYou: readonly LandedPullRequest[];
}

export const NO_TRANSITIONS: LandedTransitions = {merged: [], needsYou: []};

/** What `saved` changed against the PRs as they were (`before`, by key). */
export function landedTransitions(
    before: ReadonlyMap<string, LandedPullRequest>,
    saved: readonly LandedPullRequest[],
): LandedTransitions {
    const entered = (kind: LaneStageKind) =>
        saved.filter((pr) => pr.stage.kind === kind && before.get(pr.key)?.stage.kind !== kind);
    return {merged: entered('merged'), needsYou: entered('needsYou')};
}

/** The Dock bounces once when any PR went to Needs you; merges only show in the bubble and the rocket. */
export function bouncesDock(transitions: LandedTransitions): boolean {
    return transitions.needsYou.length > 0;
}
