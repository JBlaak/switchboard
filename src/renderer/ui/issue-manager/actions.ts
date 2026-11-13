/**
 * What the Issue manager page does (#415): open and close it, read its items
 * and an issue's thread, select (which marks seen), save notes as you type,
 * Comment… and Polish and post now, Start and claim, Snooze, Backlog, Open
 * session and Stop working on it.
 *
 * The page's components call these and nothing else.
 */
import {dispatch, getState} from '../../state/app-store';
import type {RendererEvent} from '../../state/events';
import {nextAfter, visibleRows} from '../../state/issue-manager-slice';
import {issueKeyString} from '../../../domain/plan/model';
import {resolveDefaultSessionOptions} from '../../features/dialogs/launch-options';
import {startClaudeSessionIn} from '../../features/sessions/session-actions';
import {jumpToSession} from '../session-work/plan/actions';
import {pulseSessionRow} from '../session-list/pulse';
import type {InboxItem} from '../../../domain/inbox/model';
import type {InboxTab} from '../../../domain/inbox/tabs';
import type {IssueFilter} from '../../../domain/inbox/issue-manager';
import type {SnoozeOptionView} from '../../../application/services/inbox-settings-service';

/** How long typing pauses before the notes are saved. */
export const NOTES_SAVE_MS = 400;

// ── The page ──

export function openIssueManager(): void {
    dispatch({type: 'issueManagerOpened'});
}

export function closeIssueManager(): void {
    dispatch({type: 'issueManagerClosed'});
}

/** ⌘I: the page, open or closed. */
export function toggleIssueManager(): void {
    if (getState().mainArea.route.kind === 'issueManager') closeIssueManager();
    else openIssueManager();
}

/** Ask main for the manager's items. */
export async function loadIssueItems(): Promise<void> {
    try {
        dispatch({type: 'issueManagerItemsLoaded', items: await window.api.inboxItems('issue')});
    } catch {
        // The next change asks again.
    }
}

function changed(item: InboxItem | null): void {
    if (item) dispatch({type: 'issueManagerItemChanged', item});
}

// ── Going through ──

/** Select a row (null for none): an unread one is seen, and its thread read once. */
export function selectIssue(key: string | null): void {
    dispatch({type: 'issueManagerSelected', key});
    if (!key) return;
    const item = getState().issueManager.items?.find((candidate) => candidate.key === key);
    if (item?.state.kind === 'unread') void window.api.inboxMarkRead(key).then(changed, () => {});
    if (!getState().issueManager.threads[key]) void loadThread(key);
}

export async function loadThread(key: string): Promise<void> {
    dispatch({type: 'issueManagerThreadAsked', key});
    const thread = await window.api.issueManagerThread(key).catch(() => null);
    dispatch({type: 'issueManagerThreadLoaded', key, thread});
}

/** J/K: the next or previous row. */
export function stepSelection(step: 1 | -1): void {
    const state = getState().issueManager;
    const rows = visibleRows(state);
    if (rows.length === 0) return;
    const at = rows.findIndex((item) => item.key === state.selected);
    const next = at === -1 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
    selectIssue(rows[next]!.key);
}

/** Before `key` leaves the list, the selection moves on to the row after it. */
function moveOnFrom(key: string): void {
    const state = getState().issueManager;
    if (state.selected !== key) return;
    selectIssue(nextAfter(visibleRows(state), key));
}

// ── Notes ──

const pendingNotes = new Map<string, ReturnType<typeof setTimeout>>();

/** Your notes as typed: on screen at once, saved once typing pauses. */
export function typeNotes(key: string, notes: string): void {
    dispatch({type: 'issueManagerNotesTyped', key, notes});
    const pending = pendingNotes.get(key);
    if (pending) clearTimeout(pending);
    pendingNotes.set(
        key,
        setTimeout(() => {
            pendingNotes.delete(key);
            void window.api.inboxSetNotes(key, notes).catch(() => {});
        }, NOTES_SAVE_MS),
    );
}

/** Save notes still waiting on the pause now: as the field is left, and before a Start reads them. */
export async function flushNotes(key: string): Promise<void> {
    const pending = pendingNotes.get(key);
    if (!pending) return;
    clearTimeout(pending);
    pendingNotes.delete(key);
    const notes = getState().issueManager.items?.find((item) => item.key === key)?.notes ?? '';
    await window.api.inboxSetNotes(key, notes).catch(() => null);
}

// ── Comment… (M) and Polish and post now (⇧M) ──

function notesOf(key: string): string {
    return getState().issueManager.items?.find((item) => item.key === key)?.notes ?? '';
}

export async function commentFromNotes(key: string, direct: boolean): Promise<void> {
    const notes = notesOf(key);
    if (!notes.trim()) {
        dispatch({
            type: 'issueManagerNoticed',
            notice: 'Write some notes first: Claude polishes them into the comment.',
        });
        return;
    }
    dispatch({type: 'issueManagerCommentAsked', key, direct});
    if (direct) {
        const posted = await window.api.issueManagerPolishAndPost(key, notes).catch((err: Error) => ({
            ok: false as const,
            reason: err.message || 'Could not post the comment',
        }));
        dispatch(posted.ok ? {type: 'issueManagerCommentAnswered', key, ok: true} : answeredFailed(key, posted.reason));
        if (posted.ok) void loadThread(key);
        return;
    }
    const polished = await window.api.issueManagerPolish(key, notes).catch((err: Error) => ({
        ok: false as const,
        reason: err.message || 'Could not polish the notes',
    }));
    if (polished.ok) dispatch({type: 'issueManagerCommentPolished', key, body: polished.body, footer: polished.footer});
    else dispatch(answeredFailed(key, polished.reason));
}

export function editComment(body: string): void {
    dispatch({type: 'issueManagerCommentEdited', body});
}

/** Post the preview as edited. */
export async function postComment(): Promise<void> {
    const comment = getState().issueManager.comment;
    if (comment?.phase !== 'preview') return;
    dispatch({type: 'issueManagerCommentPostAsked'});
    const posted = await window.api.issueManagerPost(comment.key, comment.body).catch((err: Error) => ({
        ok: false as const,
        reason: err.message || 'Could not post the comment',
    }));
    dispatch(
        posted.ok
            ? {type: 'issueManagerCommentAnswered', key: comment.key, ok: true}
            : answeredFailed(comment.key, posted.reason),
    );
    if (posted.ok) void loadThread(comment.key);
}

export function dismissComment(): void {
    dispatch({type: 'issueManagerCommentDismissed'});
}

function answeredFailed(key: string, reason: string): RendererEvent {
    return {type: 'issueManagerCommentAnswered', key, ok: false, reason};
}

// ── Start and claim (⏎) ──

/**
 * Claim the issue and start its session: main assigns you and makes the
 * worktree; the session starts here with the project's usual options, minus
 * `--worktree` (it is in one already), and the page stays on screen while
 * its new row pulses.
 */
export async function startIssue(key: string): Promise<void> {
    if (getState().issueManager.start?.phase === 'starting') return;
    dispatch({type: 'issueManagerStartAsked', key});
    await flushNotes(key);
    const failed = (reason: string): void => dispatch({type: 'issueManagerStartAnswered', key, ok: false, reason});
    try {
        const prepared = await window.api.issueManagerPrepareStart(key);
        if (!prepared.ok) return failed(prepared.reason);
        const {
            worktree: _worktree,
            worktreeName: _worktreeName,
            ...defaults
        } = await resolveDefaultSessionOptions(prepared.projectPath);
        const launched = await startClaudeSessionIn(
            prepared.worktreePath,
            {...defaults, initialPrompt: prepared.prompt},
            {show: false},
        );
        if (!launched.ok) return failed(launched.reason);
        moveOnFrom(key);
        changed(await window.api.issueManagerStarted(key, prepared.branch, launched.sessionId));
        pulseSessionRow(launched.sessionId);
        dispatch({
            type: 'issueManagerStartAnswered',
            key,
            ok: true,
            sessionId: launched.sessionId,
            warning: prepared.warning ?? null,
        });
        // The selection has moved on, so what came of it is said on the page.
        const number = /#(\d+)$/.exec(key)?.[1];
        dispatch({
            type: 'issueManagerNoticed',
            notice:
                `Started a session on #${number}; it is under In progress.` +
                (prepared.warning ? ' ' + prepared.warning : ''),
        });
    } catch (err) {
        failed((err as Error).message || 'Could not start the session');
    }
}

/** Open session: the one working on the issue, by its branch, or the one Start began. */
export async function openIssueSession(item: InboxItem): Promise<void> {
    if (item.facts.kind !== 'issue') return;
    const owners = await window.api.issueSessions(item.facts.repository).catch(() => ({}) as Record<string, string>);
    const owner = owners[issueKeyString({repository: item.facts.repository, number: item.facts.number})];
    for (const sessionId of [owner, item.work?.sessionId]) {
        if (sessionId && (await jumpToSession(sessionId))) return;
    }
    dispatch({type: 'issueManagerNoticed', notice: 'Its session is no longer in the list.'});
}

// ── Stop working on it ──

export function askStopWork(key: string): void {
    dispatch({type: 'issueManagerStopAsked', key});
}

export function toggleStopUnassign(): void {
    dispatch({type: 'issueManagerStopUnassignToggled'});
}

export function dismissStopWork(): void {
    dispatch({type: 'issueManagerStopDismissed'});
}

export async function confirmStopWork(): Promise<void> {
    const stop = getState().issueManager.stop;
    if (!stop) return;
    dispatch({type: 'issueManagerStopDismissed'});
    moveOnFrom(stop.key);
    const answer = await window.api.issueManagerStopWork(stop.key, stop.unassign).catch((err: Error) => ({
        item: null,
        warning: err.message || 'Could not stop working on it',
    }));
    changed(answer.item);
    if (answer.warning) dispatch({type: 'issueManagerNoticed', notice: answer.warning});
}

// ── Snooze (S) and Backlog (B) ──

export async function openSnooze(key: string): Promise<void> {
    dispatch({type: 'issueManagerSnoozeOpened', key});
    const options = await window.api.inboxSnoozeOptions().catch(() => [] as SnoozeOptionView[]);
    dispatch({type: 'issueManagerSnoozeOptions', key, options});
}

export function closeSnooze(): void {
    dispatch({type: 'issueManagerSnoozeClosed'});
}

export async function snoozeIssue(key: string, until: string | null): Promise<void> {
    dispatch({type: 'issueManagerSnoozeClosed'});
    moveOnFrom(key);
    changed(await window.api.inboxSnooze(key, until).catch(() => null));
}

export async function backlogIssue(key: string): Promise<void> {
    moveOnFrom(key);
    changed(await window.api.inboxBacklog(key).catch(() => null));
}

// ── Elsewhere ──

/** O: the issue on GitHub. */
export function openOnGitHub(item: InboxItem): void {
    if (item.facts.kind === 'issue') void window.api.openExternal(item.facts.url);
}

export function openPullRequest(item: InboxItem): void {
    if (item.facts.kind !== 'issue' || !item.work?.pullRequest) return;
    void window.api.openExternal(`https://github.com/${item.facts.repository}/pull/${item.work.pullRequest}`);
}

export function chooseTab(tab: InboxTab): void {
    dispatch({type: 'issueManagerTabChosen', tab});
}

/** A tile: the inbox filtered by it, or every row again when it is picked twice. */
export function chooseFilter(filter: IssueFilter): void {
    dispatch({type: 'issueManagerFilterChosen', filter});
}
