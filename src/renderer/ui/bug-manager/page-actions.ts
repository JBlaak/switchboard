/**
 * What the Bug manager page does (#414): opening and closing it, reading the
 * Bug manager's items and what Bugsnag says of each, and what you do to a
 * bug: seen, snooze, backlog, Fix, Open session, Stop working on it, and the
 * answers to "seen again after the merge". The page's components call these
 * and nothing else.
 */
import {dispatch, getState} from '../../state/app-store';
import {resolveBugsnagSettings} from '../../../domain/bugsnag/connection';
import {openSession, startClaudeSessionIn} from '../../features/sessions/session-actions';
import {resolveDefaultSessionOptions} from '../../features/dialogs/launch-options';
import {sessionMap} from '../../state/session-store';
import {bugCursorRow, bugRows} from '../../state/bug-page-slice';
import type {InboxItem} from '../../../domain/inbox/model';
import type {BugFilter, BugTab} from '../../state/bug-page-slice';

// ── The route ──

/** The Bug manager page takes the main area. */
export function openBugPage(): void {
    dispatch({type: 'bugPageOpened'});
}

/** Back to the session it covered, or the empty screen. */
export function closeBugPage(): void {
    dispatch({type: 'bugPageClosed'});
}

/** ⌘B: the page, open or closed. */
export function toggleBugPage(): void {
    if (getState().mainArea.route.kind === 'bugs') closeBugPage();
    else openBugPage();
}

// ── Reading ──

/** The Bug manager's items, the Bugsnag projects' names and links, and when main last polled. */
export async function loadBugPage(): Promise<void> {
    try {
        const [items, global, polledAt] = await Promise.all([
            window.api.inboxItems('bug'),
            window.api.getSetting<Record<string, unknown>>('global'),
            window.api.inboxPolledAt(),
        ]);
        dispatch({type: 'bugPageLoaded', items, projects: resolveBugsnagSettings(global).projects, polledAt});
    } catch (err) {
        dispatch({type: 'bugPageNoticed', notice: 'Could not read the Bug manager: ' + (err as Error).message});
    }
}

/** The detail pane's reads of a bug, once each while the page is open. */
export async function loadBugDetail(key: string): Promise<void> {
    if (getState().bugPage.details[key]) return;
    const detail = await window.api.bugDetail(key).catch(() => null);
    if (detail) dispatch({type: 'bugDetailLoaded', key, detail});
}

/** Rows' sparklines, one after another; main keeps each a while. */
export async function loadBugTrends(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
        if (getState().bugPage.trends[key] || getState().mainArea.route.kind !== 'bugs') continue;
        const trend = await window.api.bugTrend(key).catch(() => []);
        dispatch({type: 'bugTrendLoaded', key, trend});
    }
}

// ── Choosing ──

export function chooseBugTab(tab: BugTab): void {
    dispatch({type: 'bugTabChosen', tab});
}

/** A tile: filter the inbox by it, or the whole inbox again. */
export function chooseBugFilter(filter: BugFilter): void {
    dispatch({type: 'bugFilterChosen', filter});
}

/** The cursor on a row, which marks it seen. */
export function moveBugCursor(key: string | null): void {
    dispatch({type: 'bugCursorMoved', key});
    if (key) void markBugSeen(key);
}

/** J/K: one row down or up, marking the row it lands on seen. */
export function stepBugCursor(step: 1 | -1): void {
    const state = getState().bugPage;
    const rows = bugRows(state);
    if (rows.length === 0) return;
    const at = rows.findIndex((row) => row.key === bugCursorRow(state)?.key);
    moveBugCursor(rows[Math.min(rows.length - 1, Math.max(0, at + step))]!.key);
}

// ── What you do to a bug ──

async function changed(call: Promise<InboxItem | null>, failed: string): Promise<InboxItem | null> {
    try {
        const item = await call;
        if (item) dispatch({type: 'bugItemChanged', item});
        return item;
    } catch (err) {
        dispatch({type: 'bugPageNoticed', notice: `${failed}: ${(err as Error).message}`});
        return null;
    }
}

export async function markBugSeen(key: string): Promise<void> {
    const item = getState().bugPage.items.find((row) => row.key === key);
    if (item?.state.kind !== 'unread') return;
    dispatch({type: 'bugItemChanged', item: {...item, state: {kind: 'read'}}});
    await changed(window.api.inboxMarkRead(key), 'Could not mark it seen');
}

/** S: the snooze menu on a row, its options asked of main (the cycle ones from the Planner). */
export async function openBugSnooze(key: string): Promise<void> {
    dispatch({type: 'bugSnoozeOpened', key, options: null});
    const options = await window.api.inboxSnoozeOptions().catch(() => []);
    if (getState().bugPage.snooze?.key === key) dispatch({type: 'bugSnoozeOpened', key, options});
}

export function closeBugSnooze(): void {
    dispatch({type: 'bugSnoozeClosed'});
}

export async function snoozeBug(key: string, until: string | null): Promise<void> {
    dispatch({type: 'bugSnoozeClosed'});
    await changed(window.api.inboxSnooze(key, until), 'Could not snooze it');
}

export async function backlogBug(key: string): Promise<void> {
    await changed(window.api.inboxBacklog(key), 'Could not put it in the backlog');
}

/**
 * F: Fix. Main makes the worktree on `fix/bugsnag-…` and the prompt; the
 * session starts there with the project's usual options and comes on
 * screen; main then follows it.
 */
export async function fixBug(key: string): Promise<void> {
    if (getState().bugPage.fixing) return;
    dispatch({type: 'bugFixing', key});
    dispatch({type: 'bugPageNoticed', notice: null});
    try {
        const prepared = await window.api.bugPrepareFix(key);
        if (!prepared.ok) {
            dispatch({type: 'bugPageNoticed', notice: prepared.reason});
            return;
        }
        // The session is in its worktree already; `--worktree` would make another.
        const {
            worktree: _worktree,
            worktreeName: _name,
            ...defaults
        } = await resolveDefaultSessionOptions(prepared.projectPath);
        const launched = await startClaudeSessionIn(prepared.worktreePath, {
            ...defaults,
            initialPrompt: prepared.prompt,
        });
        if (!launched.ok) {
            dispatch({type: 'bugPageNoticed', notice: 'Could not start the Fix session: ' + launched.reason});
            return;
        }
        await changed(window.api.bugFixStarted(key, launched.sessionId), 'The Fix session started, but');
    } catch (err) {
        dispatch({type: 'bugPageNoticed', notice: 'Could not start the Fix: ' + (err as Error).message});
    } finally {
        dispatch({type: 'bugFixing', key: null});
    }
}

/** O: the bug on the Bugsnag dashboard, in the browser. */
export async function openBugInBugsnag(key: string): Promise<void> {
    await loadBugDetail(key);
    const url = getState().bugPage.details[key]?.url;
    if (url) await window.api.openExternal(url);
    else dispatch({type: 'bugPageNoticed', notice: 'Bugsnag did not say where this error is on its dashboard'});
}

export function openInBrowser(url: string): void {
    void window.api.openExternal(url);
}

/** Open session: the Fix's session on screen, by its id or else by its worktree. */
export async function openFixSession(item: InboxItem): Promise<void> {
    const work = item.fix;
    if (!work) return;
    const session =
        (work.sessionId ? sessionMap.get(work.sessionId) : undefined) ??
        [...sessionMap.values()]
            .filter((row) => row.projectPath === work.worktree)
            .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))[0];
    if (session) await openSession(session);
    else dispatch({type: 'bugPageNoticed', notice: 'The Fix session is no longer in the list'});
}

export async function stopWorkingOnBug(key: string): Promise<void> {
    await changed(window.api.bugStopWorking(key), 'Could not stop working on it');
}

export async function closeBugAgain(key: string): Promise<void> {
    await changed(window.api.bugCloseAgain(key), 'Could not close it again');
}

export async function treatBugAsRegressed(key: string): Promise<void> {
    await changed(window.api.bugTreatAsRegressed(key), 'Could not reopen it');
}
