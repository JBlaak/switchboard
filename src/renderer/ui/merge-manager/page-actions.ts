/**
 * What the Merge manager's page does (#439): open and close it (⌘⇧L, Esc),
 * read what it shows besides the lanes, move the selection (J/K), and the
 * selected row's actions: ⏎ opens the PR's session or its fix errand, T
 * Try again with the note typed for it, N Nudge the reviewer it waits on, U
 * Unland, O the PR on GitHub.
 *
 * The page's components and keys call these and nothing else.
 */
import {dispatch, getState} from '../../state/app-store';
import {sessionMap} from '../../state/session-store';
import {queueActionKey} from '../../state/project-page-slice';
import {isSamePullRequest} from '../../../domain/merge-manager/archive-on-merge';
import {pageLanes, rowActions, rowKeys, selectedRow, type PageRow} from '../../../domain/merge-manager/page';
import {jumpToSession} from '../session-work/plan/actions';
import {nudgeReviewer} from '../project-page/merge-queue-actions';
import {unlandPullRequest} from './land-actions';

// ── The page ──

/** Open the page, with `key`'s row selected when given: Open in Merge manager. */
export function openMergeManager(key?: string): void {
    dispatch(key ? {type: 'mergeManagerPageRequested', key} : {type: 'mergeManagerPageRequested'});
}

export function closeMergeManager(): void {
    dispatch({type: 'mergeManagerPageClosed'});
}

/** ⌘⇧L: the page, open or closed. */
export function toggleMergeManager(): void {
    if (getState().mainArea.route.kind === 'mergeManager') closeMergeManager();
    else openMergeManager();
}

/** Ask main for what the page shows besides the lanes; a failed read keeps what it had. */
export async function loadMergeManagerPage(): Promise<void> {
    try {
        dispatch({type: 'mergeManagerPageFactsLoaded', facts: await window.api.mergeManagerPage()});
    } catch {
        // The next change asks again.
    }
}

function notice(text: string | null): void {
    dispatch({type: 'mergeManagerPageNoticed', notice: text});
}

// ── Going through ──

export function selectMergeRow(key: string | null): void {
    dispatch({type: 'mergeManagerRowSelected', key});
}

/** J/K: the next or previous row, top to bottom across the lanes. */
export function stepMergeRow(step: 1 | -1): void {
    const lanes = pageLanes(getState().mergeManager.state);
    const keys = rowKeys(lanes);
    if (keys.length === 0) return;
    const at = keys.indexOf(selectedRow(lanes, getState().mergeManager.page.selected)?.key ?? '');
    const next = at === -1 ? (step === 1 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, at + step));
    selectMergeRow(keys[next]!);
}

// ── A row's actions ──

/**
 * ⏎: the fix errand's session while one works on the PR or gave up on it;
 * otherwise the PR's own session, the newest not archived that opened it.
 */
export async function openRowSession(row: PageRow): Promise<void> {
    const open = rowActions(row).open;
    if (!open) return;
    if (open.kind === 'errand') {
        if (!(await jumpToSession(open.sessionId))) notice(`#${row.number}'s errand is no longer in the list.`);
        return;
    }
    const owner = sessionOf(row);
    if (!owner || !(await jumpToSession(owner))) notice(`No session in the list opened #${row.number}.`);
}

/** The newest session, not archived, whose transcript opened the row's PR; null when none did. */
export function sessionOf(row: Pick<PageRow, 'repository' | 'number' | 'url'>): string | null {
    let best: {id: string; at: number} | null = null;
    for (const session of sessionMap.values()) {
        if (session.archived) continue;
        if (!(session.pullRequests ?? []).some((pr) => isSamePullRequest(pr, row))) continue;
        const at = Date.parse(session.modified) || 0;
        if (!best || at > best.at) best = {id: session.sessionId, at};
    }
    return best?.id ?? null;
}

export function typeTryAgainNote(key: string, note: string): void {
    dispatch({type: 'mergeManagerTryAgainNoteTyped', key, note});
}

/** T: a new fix errand for a PR an errand gave up on, carrying the note typed for it. */
export async function tryAgainFromPage(row: PageRow): Promise<void> {
    const page = getState().mergeManager.page;
    if (!rowActions(row).tryAgain || page.tryAgain[row.key]?.phase === 'busy') return;
    const note = page.notes[row.key]?.trim() || null;
    dispatch({type: 'mergeManagerTryAgainAsked', key: row.key});
    const result = await window.api
        .mergeManagerTryAgain(row.repository, row.number, note)
        .catch((err: Error) => ({ok: false as const, reason: err.message || 'Could not try again'}));
    dispatch({
        type: 'mergeManagerTryAgainAnswered',
        key: row.key,
        result: result.ok ? {ok: true} : {ok: false, reason: result.reason},
    });
    if (result.ok) notice(`A new fix errand is on #${row.number}.`);
}

/** N: nudge the reviewer the row waits on, from the repository's local checkout. */
export async function nudgeFromPage(row: PageRow): Promise<void> {
    const reviewer = rowActions(row).nudge;
    if (!reviewer) return;
    const checkout = getState().mergeManager.page.facts?.checkouts[row.repository.toLowerCase()];
    if (!checkout) {
        notice(`Nudge needs a local checkout of ${row.repository} to start its session in.`);
        return;
    }
    await nudgeReviewer(checkout, row.repository, {number: row.number, title: row.title, url: row.url}, reviewer);
    const outcome = getState().projectPage.queueActions[queueActionKey('nudge', row.number, reviewer)];
    // On yes, the nudge's session row pulses in the sidebar; only a failure is said here.
    if (outcome?.phase === 'failed') notice(outcome.reason);
}

/** U: take the row's PR out of its lane; running CI and errands are left alone. */
export async function unlandFromPage(row: PageRow): Promise<void> {
    if (!rowActions(row).unland) return;
    await unlandPullRequest(row.repository, row.number);
}

/** O: the PR on GitHub. */
export function openRowOnGitHub(row: Pick<PageRow, 'url'>): void {
    void window.api.openExternal(row.url);
}
