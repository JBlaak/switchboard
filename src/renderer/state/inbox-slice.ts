/**
 * The managers' inbox (#413), renderer side: both managers' unread and urgent
 * counts and which of them are set up, as main pushed them last
 * (`inboxChanged`), for the managers on the empty screen (#416), and the bugs
 * being triaged, for the Errands shelf. The pages ask main for the items
 * themselves.
 */
import {
    EMPTY_INBOX_SUMMARY,
    type InboxManager,
    type InboxSummary,
    type ManagerCounts,
    type TriageErrandView,
} from '../../domain/inbox/model';
import type {RendererEvent} from './events';

export interface InboxSliceState {
    readonly summary: InboxSummary;
}

export const initialInboxState: InboxSliceState = {summary: EMPTY_INBOX_SUMMARY};

export function inboxReducer(state: InboxSliceState, event: RendererEvent): InboxSliceState {
    if (event.type !== 'inboxChanged') return state;
    const {summary} = event;
    const same = (manager: InboxManager): boolean =>
        sameCounts(state.summary[manager], summary[manager]) &&
        state.summary.configured[manager] === summary.configured[manager];
    return same('bug') && same('issue') && sameTriaging(state.summary.triaging, summary.triaging) ? state : {summary};
}

/** Whether two pushes triage the same bugs in the same state; main sends a fresh list every time. */
function sameTriaging(a: readonly TriageErrandView[], b: readonly TriageErrandView[]): boolean {
    if (a.length !== b.length) return false;
    return a.every(
        (view, i) =>
            view.sessionId === b[i].sessionId &&
            view.key === b[i].key &&
            view.title === b[i].title &&
            view.repository === b[i].repository &&
            view.needsYou === b[i].needsYou,
    );
}

function sameCounts(a: ManagerCounts, b: ManagerCounts): boolean {
    return a.unread === b.unread && a.urgent === b.urgent;
}

/** A manager's counts. */
export function managerCountsOf(state: InboxSliceState, manager: InboxManager): ManagerCounts {
    return state.summary[manager];
}

/** Matches `ManagerState` in @jblaak/patch. */
export type ManagerPose = 'calm' | 'unread' | 'urgent';

/** What a manager on the empty screen shows: its pose and its unread tag. */
export interface ManagerFigure {
    readonly pose: ManagerPose;
    readonly count: number;
}

/**
 * A manager's figure, or null while it is not set up and stays off the
 * empty screen. Nothing unread is `calm`; an unread trending or regressed
 * bug is `urgent`; anything else unread is `unread`.
 */
export function managerFigureOf(state: InboxSliceState, manager: InboxManager): ManagerFigure | null {
    if (!state.summary.configured[manager]) return null;
    const {unread, urgent} = state.summary[manager];
    const pose: ManagerPose = unread === 0 ? 'calm' : urgent > 0 ? 'urgent' : 'unread';
    return {pose, count: unread};
}
