/**
 * The tabs a manager's page (#414, #415) sorts its items into: the inbox
 * (unread and read), what is being worked on, what is done, and what was
 * put away.
 */
import type {InboxItem, InboxState} from './model';

export type InboxTab = 'inbox' | 'inProgress' | 'done' | 'snoozed' | 'backlog';

export const INBOX_TABS: readonly InboxTab[] = ['inbox', 'inProgress', 'done', 'snoozed', 'backlog'];

export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
    inbox: 'Inbox',
    inProgress: 'In progress',
    done: 'Done',
    snoozed: 'Snoozed',
    backlog: 'Backlog',
};

/** The tab an item in this state is listed under. */
export function tabOf(state: InboxState): InboxTab {
    switch (state.kind) {
        case 'unread':
        case 'read':
            return 'inbox';
        default:
            return state.kind;
    }
}

/** How many items each tab lists. */
export function tabCounts(items: readonly InboxItem[]): Record<InboxTab, number> {
    const counts: Record<InboxTab, number> = {inbox: 0, inProgress: 0, done: 0, snoozed: 0, backlog: 0};
    for (const item of items) counts[tabOf(item.state)]++;
    return counts;
}
