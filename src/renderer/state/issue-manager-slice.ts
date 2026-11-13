/**
 * The Issue manager page (#415), renderer side: the manager's items as main
 * last answered them, the tab and tile on screen, the selected issue and its
 * thread, and what a Comment, a Start or a Stop is doing.
 *
 * The items are main's (`inboxItems`); the page asks again as it opens and
 * whenever the inbox changes. An action answers the item after it, which
 * replaces the one held, so the list moves without waiting for the next ask.
 */
import {issueChip, matchesFilter, type IssueFilter, type IssueThread} from '../../domain/inbox/issue-manager';
import {tabOf, type InboxTab} from '../../domain/inbox/tabs';
import type {InboxItem} from '../../domain/inbox/model';
import type {SnoozeOptionView} from '../../application/services/inbox-settings-service';
import type {RendererEvent} from './events';

export type ThreadLoad = {readonly phase: 'loading'} | {readonly phase: 'ok'; readonly thread: IssueThread | null};

/** Comment… (M) from the preview to the post, or Polish and post now (⇧M) straight through. */
export type CommentFlow =
    | {readonly key: string; readonly phase: 'polishing'; readonly direct: boolean}
    | {readonly key: string; readonly phase: 'preview'; readonly body: string; readonly footer: string}
    | {readonly key: string; readonly phase: 'posting'; readonly body: string; readonly footer: string}
    | {readonly key: string; readonly phase: 'posted'}
    | {readonly key: string; readonly phase: 'failed'; readonly reason: string};

export type StartFlow =
    | {readonly key: string; readonly phase: 'starting'}
    | {readonly key: string; readonly phase: 'started'; readonly sessionId: string; readonly warning: string | null}
    | {readonly key: string; readonly phase: 'failed'; readonly reason: string};

export interface IssueManagerState {
    /** Null until main first answers. */
    readonly items: readonly InboxItem[] | null;
    readonly tab: InboxTab;
    /** The tile picked as the inbox's filter; null shows every row. */
    readonly filter: IssueFilter | null;
    readonly selected: string | null;
    readonly threads: Readonly<Record<string, ThreadLoad>>;
    readonly comment: CommentFlow | null;
    readonly start: StartFlow | null;
    /** The item whose Snooze menu is open, and its options once main answered. */
    readonly snooze: {readonly key: string; readonly options: readonly SnoozeOptionView[] | null} | null;
    /** Stop working on it, asked: whether to also take you off the issue on GitHub. */
    readonly stop: {readonly key: string; readonly unassign: boolean} | null;
    readonly notice: string | null;
}

export const initialIssueManagerState: IssueManagerState = {
    items: null,
    tab: 'inbox',
    filter: null,
    selected: null,
    threads: {},
    comment: null,
    start: null,
    snooze: null,
    stop: null,
    notice: null,
};

export type IssueManagerEvent =
    /** The page takes the main area: ⌘I. */
    | {type: 'issueManagerOpened'}
    /** Esc or ⌘I again: back to the session to return to, or the empty screen. */
    | {type: 'issueManagerClosed'}
    | {type: 'issueManagerItemsLoaded'; items: InboxItem[]}
    /** An action's answer: the item as it is now. */
    | {type: 'issueManagerItemChanged'; item: InboxItem}
    | {type: 'issueManagerTabChosen'; tab: InboxTab}
    | {type: 'issueManagerFilterChosen'; filter: IssueFilter | null}
    | {type: 'issueManagerSelected'; key: string | null}
    | {type: 'issueManagerThreadAsked'; key: string}
    | {type: 'issueManagerThreadLoaded'; key: string; thread: IssueThread | null}
    /** Your notes, as typed; saved to main a moment later. */
    | {type: 'issueManagerNotesTyped'; key: string; notes: string}
    | {type: 'issueManagerCommentAsked'; key: string; direct: boolean}
    | {type: 'issueManagerCommentPolished'; key: string; body: string; footer: string}
    | {type: 'issueManagerCommentEdited'; body: string}
    | {type: 'issueManagerCommentPostAsked'}
    | {type: 'issueManagerCommentAnswered'; key: string; ok: true}
    | {type: 'issueManagerCommentAnswered'; key: string; ok: false; reason: string}
    | {type: 'issueManagerCommentDismissed'}
    | {type: 'issueManagerStartAsked'; key: string}
    | {type: 'issueManagerStartAnswered'; key: string; ok: true; sessionId: string; warning: string | null}
    | {type: 'issueManagerStartAnswered'; key: string; ok: false; reason: string}
    | {type: 'issueManagerSnoozeOpened'; key: string}
    | {type: 'issueManagerSnoozeOptions'; key: string; options: SnoozeOptionView[]}
    | {type: 'issueManagerSnoozeClosed'}
    | {type: 'issueManagerStopAsked'; key: string}
    | {type: 'issueManagerStopUnassignToggled'}
    | {type: 'issueManagerStopDismissed'}
    | {type: 'issueManagerNoticed'; notice: string | null};

export function issueManagerReducer(state: IssueManagerState, event: RendererEvent): IssueManagerState {
    switch (event.type) {
        // A fresh look every time: what was open last time is put away; the tab stays.
        case 'issueManagerOpened':
            return {...state, comment: null, snooze: null, stop: null, notice: null};

        case 'issueManagerItemsLoaded':
            return {...state, items: event.items};

        case 'issueManagerItemChanged': {
            if (!state.items) return state;
            const at = state.items.findIndex((item) => item.key === event.item.key);
            const items =
                at === -1 ? [...state.items, event.item] : state.items.map((item, i) => (i === at ? event.item : item));
            return {...state, items};
        }

        case 'issueManagerTabChosen':
            return state.tab === event.tab
                ? state
                : {...state, tab: event.tab, filter: null, selected: null, snooze: null, stop: null};

        case 'issueManagerFilterChosen':
            return {...state, tab: 'inbox', filter: state.filter === event.filter ? null : event.filter};

        case 'issueManagerSelected':
            if (state.selected === event.key) return state;
            return {
                ...state,
                selected: event.key,
                snooze: null,
                stop: null,
                // A comment's preview stays with its issue, but not on screen under another.
                comment: state.comment && state.comment.key !== event.key ? null : state.comment,
            };

        case 'issueManagerThreadAsked':
            return {...state, threads: {...state.threads, [event.key]: {phase: 'loading'}}};

        case 'issueManagerThreadLoaded':
            return {...state, threads: {...state.threads, [event.key]: {phase: 'ok', thread: event.thread}}};

        case 'issueManagerNotesTyped':
            return state.items
                ? {
                      ...state,
                      items: state.items.map((item) => (item.key === event.key ? {...item, notes: event.notes} : item)),
                  }
                : state;

        case 'issueManagerCommentAsked':
            return {...state, comment: {key: event.key, phase: 'polishing', direct: event.direct}};

        case 'issueManagerCommentPolished':
            if (state.comment?.key !== event.key || state.comment.phase !== 'polishing') return state;
            return {...state, comment: {key: event.key, phase: 'preview', body: event.body, footer: event.footer}};

        case 'issueManagerCommentEdited':
            return state.comment?.phase === 'preview'
                ? {...state, comment: {...state.comment, body: event.body}}
                : state;

        case 'issueManagerCommentPostAsked':
            return state.comment?.phase === 'preview'
                ? {...state, comment: {...state.comment, phase: 'posting'}}
                : state;

        case 'issueManagerCommentAnswered':
            if (state.comment?.key !== event.key) return state;
            return {
                ...state,
                comment: event.ok
                    ? {key: event.key, phase: 'posted'}
                    : {key: event.key, phase: 'failed', reason: event.reason},
            };

        case 'issueManagerCommentDismissed':
            return state.comment ? {...state, comment: null} : state;

        case 'issueManagerStartAsked':
            return {...state, start: {key: event.key, phase: 'starting'}, notice: null};

        case 'issueManagerStartAnswered':
            return {
                ...state,
                start: event.ok
                    ? {key: event.key, phase: 'started', sessionId: event.sessionId, warning: event.warning}
                    : {key: event.key, phase: 'failed', reason: event.reason},
            };

        case 'issueManagerSnoozeOpened':
            return {...state, snooze: {key: event.key, options: null}, stop: null};

        case 'issueManagerSnoozeOptions':
            return state.snooze?.key === event.key
                ? {...state, snooze: {key: event.key, options: event.options}}
                : state;

        case 'issueManagerSnoozeClosed':
            return state.snooze ? {...state, snooze: null} : state;

        case 'issueManagerStopAsked':
            return {...state, stop: {key: event.key, unassign: false}, snooze: null};

        case 'issueManagerStopUnassignToggled':
            return state.stop ? {...state, stop: {...state.stop, unassign: !state.stop.unassign}} : state;

        case 'issueManagerStopDismissed':
            return state.stop ? {...state, stop: null} : state;

        case 'issueManagerNoticed':
            return {...state, notice: event.notice};

        default:
            return state;
    }
}

// ── What the page shows ──

/** A repository's rows, as the list groups them. */
export interface IssueGroup {
    readonly repository: string;
    readonly items: readonly InboxItem[];
}

/** The items of the tab on screen, the inbox's filtered by its tile, grouped by repository, newest update first. */
export function visibleGroups(state: Pick<IssueManagerState, 'items' | 'tab' | 'filter'>): IssueGroup[] {
    const byRepository = new Map<string, InboxItem[]>();
    for (const item of state.items ?? []) {
        if (tabOf(item.state) !== state.tab) continue;
        if (state.tab === 'inbox' && !matchesFilter(item, state.filter)) continue;
        const group = byRepository.get(item.source) ?? [];
        group.push(item);
        byRepository.set(item.source, group);
    }
    return [...byRepository.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([repository, items]) => ({repository, items: items.sort(newestFirst)}));
}

/** The rows in the order J and K walk them. */
export function visibleRows(state: Pick<IssueManagerState, 'items' | 'tab' | 'filter'>): InboxItem[] {
    return visibleGroups(state).flatMap((group) => group.items);
}

/** The selected item, while it is listed. */
export function selectedItem(state: IssueManagerState): InboxItem | null {
    return visibleRows(state).find((item) => item.key === state.selected) ?? null;
}

/**
 * The row the selection moves to when `key` leaves the list (snoozed,
 * backlogged, started): the one after it, or before it at the end.
 */
export function nextAfter(rows: readonly InboxItem[], key: string): string | null {
    const at = rows.findIndex((item) => item.key === key);
    if (at === -1) return null;
    return rows[at + 1]?.key ?? rows[at - 1]?.key ?? null;
}

/** Whether an unread row is there for a reason the inbox wants seen. */
export function isUnread(item: InboxItem): boolean {
    return issueChip(item) !== null;
}

function newestFirst(a: InboxItem, b: InboxItem): number {
    const at = (item: InboxItem): string => (item.facts.kind === 'issue' ? item.facts.updatedAt : '');
    return at(b).localeCompare(at(a));
}
