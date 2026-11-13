/**
 * The Merge manager (#434), renderer side: every lane with a landed PR and
 * how many PRs need you, as main pushed them last (`mergeManagerChanged`),
 * for Land it, the Merge manager's page and its figure (#436, #439, #440).
 */
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
