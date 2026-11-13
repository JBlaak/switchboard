/**
 * The managers' inbox (#413), renderer side: both managers' unread and urgent
 * counts, as main pushed them last (`inboxChanged`), for the managers on the
 * empty screen (#416). The pages ask main for the items themselves.
 */
import {EMPTY_INBOX_SUMMARY, type InboxManager, type InboxSummary, type ManagerCounts} from '../../domain/inbox/model';
import type {RendererEvent} from './events';

export interface InboxSliceState {
    readonly summary: InboxSummary;
}

export const initialInboxState: InboxSliceState = {summary: EMPTY_INBOX_SUMMARY};

export function inboxReducer(state: InboxSliceState, event: RendererEvent): InboxSliceState {
    if (event.type !== 'inboxChanged') return state;
    const {summary} = event;
    const same = (manager: InboxManager): boolean => sameCounts(state.summary[manager], summary[manager]);
    return same('bug') && same('issue') ? state : {summary};
}

function sameCounts(a: ManagerCounts, b: ManagerCounts): boolean {
    return a.unread === b.unread && a.urgent === b.urgent;
}

/** A manager's counts. */
export function managerCountsOf(state: InboxSliceState, manager: InboxManager): ManagerCounts {
    return state.summary[manager];
}
