/**
 * The Merge manager (#434), renderer side: every lane with a landed PR and
 * how many PRs need you, as main pushed them last (`mergeManagerChanged`),
 * for Land it, the Merge manager's page and its figure (#436, #439, #440),
 * and the rocket an archived landed session leaves with (#440).
 */
import {isSamePullRequest, type SessionPullRequestRef} from '../../domain/merge-manager/archive-on-merge';
import {EMPTY_MERGE_MANAGER_STATE, type MergeManagerState} from '../../domain/merge-manager/model';
import type {RendererEvent} from './events';

export interface MergeManagerSliceState {
    readonly state: MergeManagerState;
}

export const initialMergeManagerState: MergeManagerSliceState = {state: EMPTY_MERGE_MANAGER_STATE};

export function mergeManagerReducer(state: MergeManagerSliceState, event: RendererEvent): MergeManagerSliceState {
    if (event.type !== 'mergeManagerChanged') return state;
    return {state: event.state};
}

/** How many landed PRs need you. */
export function needsYouCount(state: MergeManagerSliceState): number {
    return state.state.needsYou;
}

/**
 * Was any of these sessions' PRs landed (#440)? Archiving one launches the
 * rocket instead of confetti. Merged PRs stay in the lanes a while, so a
 * session archived on its PR's merge still counts.
 */
export function isLandedSession(
    state: MergeManagerSliceState,
    sessions: readonly {readonly pullRequests?: readonly SessionPullRequestRef[]}[],
): boolean {
    const landed = state.state.lanes.flatMap((lane) => lane.pullRequests);
    return sessions.some((session) =>
        (session.pullRequests ?? []).some((pr) => landed.some((candidate) => isSamePullRequest(pr, candidate))),
    );
}
