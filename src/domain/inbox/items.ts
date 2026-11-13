/**
 * The inbox's state machine (#413): how a poll's answer moves the items of
 * one source, what you can do to an item, when a put-away item comes back,
 * and when one leaves.
 *
 * **Arriving.** Everything a source answers that the inbox does not hold yet
 * arrives unread, the first sync's whole backlog included: nothing is taken
 * as read for you.
 *
 * **Waking.** A read item, one snoozed until it changes, or one in the
 * backlog turns unread when it changes in a way the inbox cares about:
 *
 * - an issue gets a new comment (not one of yours) or a commit references it;
 * - a bug starts trending, or regresses.
 *
 * Nothing else wakes it: more events on a bug, an edited title or a new label
 * on an issue only update what the row shows. A timed snooze wakes at its
 * time (`wakeDue`), not on a change. Unread items stay unread; in-progress
 * and done ones are the managers' pages' to move.
 *
 * **Leaving.** An item the source no longer answers has left it: an issue
 * that closed, got a parent, joined a plan or was assigned to someone else,
 * a bug fixed or ignored in Bugsnag. It is dropped, but only when the source
 * answered in full (a capped answer cannot say what is missing) or answered
 * it as no longer the inbox's (`excluded`), and only
 * from the inbox's own states: an in-progress or done item stays for its page
 * to finish. A done item is dropped seven days after it was done (`expired`).
 */
import type {TrendingThresholds} from '../bugsnag/connection';
import {bugSignals} from './signals';
import {inboxKey, isUrgent, managerOf, sourceOf} from './model';
import type {
    BugFacts,
    BugSignals,
    InboxFacts,
    InboxItem,
    InboxManager,
    InboxStage,
    InboxState,
    InboxSummary,
    IssueFacts,
    ManagerCounts,
} from './model';

/** How long a done item is kept under Done. */
export const DONE_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

const UNREAD: InboxState = {kind: 'unread'};
const READ: InboxState = {kind: 'read'};

/** What a sync needs besides the answer. */
export interface SyncContext {
    readonly now: number;
    /** The source answered every item it has, so one it left out has left. */
    readonly complete: boolean;
    /**
     * Keys the source answered that are not the inbox's (an issue now
     * assigned to someone else, or in a plan): those have left even from an
     * answer that is not complete.
     */
    readonly excluded?: ReadonlySet<string>;
    /** When the source was first synced: a bug first seen since then is new. */
    readonly watchingSince: number;
    readonly thresholds: TrendingThresholds;
    /** The user `gh` signs in as: their own comments wake nothing. Null when not known. */
    readonly viewer: string | null;
}

export interface SyncResult {
    /** The source's items after the sync: arrived, updated, and the ones that stay unanswered. */
    readonly items: InboxItem[];
    /** The keys of the items that left. */
    readonly removed: string[];
}

/** Whether an item is in one of the inbox's own states, the ones a change can wake and a poll can drop. */
export function inInbox(state: InboxState): boolean {
    return state.kind === 'unread' || state.kind === 'read' || state.kind === 'snoozed' || state.kind === 'backlog';
}

/** Whether a change wakes an item in this state. */
function wakesOnChange(state: InboxState): boolean {
    return state.kind === 'read' || state.kind === 'backlog' || (state.kind === 'snoozed' && state.until === null);
}

/** Fold one source's answer into the items the inbox holds for it. */
export function syncSource(
    known: readonly InboxItem[],
    fetched: readonly InboxFacts[],
    context: SyncContext,
): SyncResult {
    const byKey = new Map(known.map((item) => [item.key, item]));
    const answered = new Set<string>();
    const items: InboxItem[] = [];
    for (const facts of fetched) {
        const key = inboxKey(facts);
        if (answered.has(key)) continue;
        answered.add(key);
        const before = byKey.get(key);
        items.push(before ? updated(before, facts, context) : arrived(facts, context));
    }
    const removed: string[] = [];
    for (const item of known) {
        if (answered.has(item.key)) continue;
        const left = context.complete || context.excluded?.has(item.key) === true;
        if (left && inInbox(item.state)) removed.push(item.key);
        else items.push(item);
    }
    return {items, removed};
}

function arrived(facts: InboxFacts, context: SyncContext): InboxItem {
    return {
        key: inboxKey(facts),
        manager: managerOf(facts),
        source: sourceOf(facts),
        createdAt: context.now,
        state: UNREAD,
        facts,
        signals: facts.kind === 'bug' ? signalsOf(facts, context, false) : null,
        notes: '',
    };
}

function updated(before: InboxItem, facts: InboxFacts, context: SyncContext): InboxItem {
    const signals = facts.kind === 'bug' ? signalsOf(facts, context, before.signals?.regressed === true) : null;
    const changed =
        facts.kind === 'bug'
            ? bugChanged(before.signals, signals!)
            : before.facts.kind === 'issue' && issueChanged(before.facts, facts, context.viewer);
    return {
        ...before,
        facts,
        signals,
        state: changed && wakesOnChange(before.state) ? UNREAD : before.state,
    };
}

function signalsOf(facts: BugFacts, context: SyncContext, regressed: boolean): BugSignals {
    return bugSignals(facts, {watchingSince: context.watchingSince, thresholds: context.thresholds, regressed});
}

/** A bug changes when it starts trending or regresses. */
function bugChanged(before: BugSignals | null, after: BugSignals): boolean {
    return (after.trending && before?.trending !== true) || (after.regressed && before?.regressed !== true);
}

/** An issue changes when it gets a comment by someone else, or a commit references it. */
function issueChanged(before: IssueFacts, after: IssueFacts, viewer: string | null): boolean {
    const commented = after.comments > before.comments && (viewer === null || after.lastCommentBy !== viewer);
    return commented || after.references > before.references;
}

/**
 * The keys of the items whose source is no longer watched (a Bugsnag project
 * opted out, a repository whose Watch issues was switched off), from the
 * inbox's own states.
 */
export function unwatched(items: readonly InboxItem[], manager: InboxManager, watched: ReadonlySet<string>): string[] {
    return items
        .filter((item) => item.manager === manager && !watched.has(item.source) && inInbox(item.state))
        .map((item) => item.key);
}

// ── What you do to an item ──

/** Seen: an unread item turns read. Any other state stays. */
export function markRead(item: InboxItem): InboxItem {
    return item.state.kind === 'unread' ? {...item, state: READ} : item;
}

/** Put away until `until` (epoch ms), or until it changes (null). Only from the inbox's own states. */
export function snooze(item: InboxItem, until: number | null): InboxItem {
    return inInbox(item.state) ? {...item, state: {kind: 'snoozed', until}} : item;
}

/** Into the backlog, until it changes. Only from the inbox's own states. */
export function toBacklog(item: InboxItem): InboxItem {
    return inInbox(item.state) ? {...item, state: {kind: 'backlog'}} : item;
}

/** A Fix or Start session took it on. A done item can be started again. */
export function startWork(item: InboxItem, stage: InboxStage = 'working'): InboxItem {
    return {...item, state: {kind: 'inProgress', stage}};
}

/** An in-progress item moved on a stage. Any other state stays. */
export function setStage(item: InboxItem, stage: InboxStage): InboxItem {
    if (item.state.kind !== 'inProgress' || item.state.stage === stage) return item;
    return {...item, state: {kind: 'inProgress', stage}};
}

/** Merged or fixed: under Done from `at`. A bug's regression is settled by it. */
export function finish(item: InboxItem, at: number): InboxItem {
    return {
        ...item,
        state: {kind: 'done', at},
        signals: item.signals ? {...item.signals, regressed: false} : null,
    };
}

/** Stop working on it, or a session that ended without a PR: back in the inbox, read. */
export function returnToInbox(item: InboxItem): InboxItem {
    return item.state.kind === 'inProgress' || item.state.kind === 'done' ? {...item, state: READ} : item;
}

/**
 * The Bug manager page judged a bug regressed (#414): it is marked so and
 * comes back unread, from Done too. One being worked on keeps its stage.
 */
export function markRegressed(item: InboxItem): InboxItem {
    if (!item.signals) return item;
    const signals = {...item.signals, regressed: true};
    return {...item, signals, state: item.state.kind === 'inProgress' ? item.state : UNREAD};
}

export function setNotes(item: InboxItem, notes: string): InboxItem {
    return item.notes === notes ? item : {...item, notes};
}

// ── Time ──

/** The items whose timed snooze is up at `now`, woken. */
export function wakeDue(items: readonly InboxItem[], now: number): InboxItem[] {
    return items
        .filter((item) => item.state.kind === 'snoozed' && item.state.until !== null && item.state.until <= now)
        .map((item) => ({...item, state: UNREAD}));
}

/** The keys of the done items kept long enough at `now`. */
export function expired(items: readonly InboxItem[], now: number): string[] {
    return items
        .filter((item) => item.state.kind === 'done' && now - item.state.at >= DONE_KEPT_MS)
        .map((item) => item.key);
}

// ── Counting ──

/** A manager's counts: unread items, and the urgent ones among them. In-progress items never count. */
export function managerCounts(items: readonly InboxItem[], manager: InboxManager): ManagerCounts {
    let unread = 0;
    let urgent = 0;
    for (const item of items) {
        if (item.manager !== manager || item.state.kind !== 'unread') continue;
        unread++;
        if (isUrgent(item)) urgent++;
    }
    return {unread, urgent};
}

export function inboxSummary(items: readonly InboxItem[]): InboxSummary {
    return {bug: managerCounts(items, 'bug'), issue: managerCounts(items, 'issue')};
}
