/**
 * What a key does on the Issue manager page (#415): J/K (or ↓/↑) move to the
 * next or previous issue, and on the selected one C focuses your notes, M
 * polishes them into a comment to preview, ⇧M polishes and posts at once,
 * ⏎ starts and claims it (or, once started, opens its session), S snoozes,
 * B puts it in the backlog and O opens it on GitHub.
 *
 * Only keys without ⌘, ⌃ or ⌥ reach this, never one typed into a field.
 * Pure, so it is tested in node; the page carries the answer out.
 */
import type {InboxItem} from '../../../domain/inbox/model';

export type IssueKeyAction =
    | {readonly kind: 'step'; readonly step: 1 | -1}
    | {
          readonly kind: 'notes' | 'comment' | 'postNow' | 'start' | 'openSession' | 'snooze' | 'backlog' | 'github';
          readonly item: InboxItem;
      };

/** Whether the row's Backlog button shows: in the inbox or snoozed, not already in the backlog. */
export function canBacklog(item: InboxItem): boolean {
    const state = item.state.kind;
    return state === 'unread' || state === 'read' || state === 'snoozed';
}

export function issueKeyAction(key: string, selected: InboxItem | null): IssueKeyAction | null {
    if (key === 'j' || key === 'ArrowDown') return {kind: 'step', step: 1};
    if (key === 'k' || key === 'ArrowUp') return {kind: 'step', step: -1};
    if (!selected) return null;
    const state = selected.state.kind;
    const inInbox = state === 'unread' || state === 'read' || state === 'snoozed' || state === 'backlog';
    switch (key) {
        case 'c':
            return {kind: 'notes', item: selected};
        case 'm':
            return {kind: 'comment', item: selected};
        case 'M':
            return {kind: 'postNow', item: selected};
        case 'Enter':
            return state === 'inProgress' ? {kind: 'openSession', item: selected} : {kind: 'start', item: selected};
        case 's':
            return inInbox ? {kind: 'snooze', item: selected} : null;
        case 'b':
            return inInbox ? {kind: 'backlog', item: selected} : null;
        case 'o':
            return {kind: 'github', item: selected};
        default:
            return null;
    }
}
