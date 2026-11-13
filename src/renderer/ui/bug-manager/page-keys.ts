/**
 * The Bug manager page's keys (#414), bare and never in an input: J/K (↓/↑)
 * move the cursor and mark the row seen; on the row under it F fixes (on an
 * in-progress bug ⏎ or F opens its session), S snoozes, B sends it to the
 * backlog and O opens it in Bugsnag. Only the keys that fit the row's state
 * act.
 */
import type {InboxItem} from '../../../domain/inbox/model';

export type BugKeyAction =
    | {readonly kind: 'cursor'; readonly step: 1 | -1}
    | {readonly kind: 'fix'; readonly key: string}
    | {readonly kind: 'openSession'; readonly item: InboxItem}
    | {readonly kind: 'snooze'; readonly key: string}
    | {readonly kind: 'backlog'; readonly key: string}
    | {readonly kind: 'bugsnag'; readonly key: string};

/** Whether the item is one you can still sort: in the inbox, snoozed or in the backlog. */
function sortable(item: InboxItem): boolean {
    const kind = item.state.kind;
    return kind === 'unread' || kind === 'read' || kind === 'snoozed' || kind === 'backlog';
}

/** What `key` does to the row under the cursor; null when it does nothing. */
export function bugKeyAction(key: string, row: InboxItem | null): BugKeyAction | null {
    if (key === 'j' || key === 'ArrowDown') return {kind: 'cursor', step: 1};
    if (key === 'k' || key === 'ArrowUp') return {kind: 'cursor', step: -1};
    if (!row) return null;
    switch (key) {
        case 'f':
        case 'Enter':
            if (row.state.kind === 'inProgress') return {kind: 'openSession', item: row};
            return sortable(row) || row.state.kind === 'done' ? {kind: 'fix', key: row.key} : null;
        case 's':
            return sortable(row) && row.state.kind !== 'snoozed' ? {kind: 'snooze', key: row.key} : null;
        case 'b':
            return sortable(row) && row.state.kind !== 'backlog' ? {kind: 'backlog', key: row.key} : null;
        case 'o':
            return {kind: 'bugsnag', key: row.key};
        default:
            return null;
    }
}
