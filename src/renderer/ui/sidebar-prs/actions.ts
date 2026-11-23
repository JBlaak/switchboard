/**
 * What the sidebar's pull request list does: read your open PRs, open one in
 * the main area, land it, open it on GitHub, and take and give back the
 * keyboard.
 *
 * A PR opens on its detail page, the Session work page: the session that
 * opened it, put on screen with its page on that PR, when one did
 * (`sessionOf`, as the Merge manager finds it); otherwise the PR's own page
 * (`pullRequestPageId`), which main serves without a session.
 *
 * Land it goes through `landPullRequest` like every other Land it (the toast
 * with Undo, the PR moving into its lane as main pushes the lanes), and the
 * rocket takes off from this list's row.
 */
import {dispatch, getState} from '../../state/app-store';
import {landBusy} from '../../state/merge-manager-slice';
import {highlightedSession} from '../../state/main-area-slice';
import {openSessions} from '../../state/session-store';
import {pullRequestPageId} from '../../../domain/session-work/pull-request-link';
import {landPullRequest} from '../merge-manager/land-actions';
import {loadNotLanded} from '../merge-manager/not-landed-actions';
import {openRowOnGitHub, sessionOf} from '../merge-manager/page-actions';
import {openSessionWork, openSessionWorkFromRow} from '../session-work/actions';
import {
    findListRow,
    onScreenKey,
    pullRequestList,
    pullRequestOnScreen,
    startListKey,
    stepListKey,
    listKeys,
    type PullRequestListRepo,
    type PullRequestListRow,
} from './pr-list-rows';

/** The element that takes the list's keys: the list itself, inside `#sidebar-prs`. */
export const PR_LIST_ID = 'pr-list';

function listElement(): HTMLElement | null {
    return document.getElementById(PR_LIST_ID);
}

/** The list as the store has it now. */
function currentList(): PullRequestListRepo[] {
    const {mergeManager} = getState();
    return pullRequestList(mergeManager.state, mergeManager.notLanded);
}

/** The key of the row whose PR the main area shows now; null for none. */
export function onScreenRowKey(repos: readonly PullRequestListRepo[] = currentList()): string | null {
    const {mainArea, sessionWork} = getState();
    return onScreenKey(repos, pullRequestOnScreen(mainArea.route, sessionWork.page));
}

// ── Reading ──

/** Ask main for your open PRs (main keeps them 30 s); the lanes come by themselves. */
export function readPullRequests(): Promise<void> {
    dispatch({type: 'pullRequestListReadStarted'});
    return loadNotLanded();
}

// ── A row ──

/**
 * A click or ⏎: the PR's detail page in the main area. The session that
 * opened it, on screen with its work page on the PR; else the PR's own page.
 */
export async function openPullRequestRow(
    row: Pick<PullRequestListRow, 'repository' | 'number' | 'url'>,
): Promise<void> {
    const ref = {repository: row.repository, number: row.number};
    const owner = sessionOf(row);
    if (owner && (await openSessionWorkFromRow(owner, {pullRequest: ref}))) return;
    await openSessionWork(pullRequestPageId(ref));
}

/** Land it on a row's PR, the rocket from `from`; nothing for a row that cannot land or is landing already. */
export function landPullRequestRow(row: PullRequestListRow, from?: Element): void {
    if (!row.land) return;
    if (landBusy(getState().mergeManager, row.repository, row.number)) return;
    void landPullRequest(row.repository, row.number, from);
}

export function openPullRequestRowOnGitHub(row: Pick<PullRequestListRow, 'url'>): void {
    openRowOnGitHub(row);
}

// ── The keyboard ──

export function setPullRequestCursor(key: string | null): void {
    dispatch({type: 'pullRequestListCursorSet', key});
}

/** The row element with `key`. */
export function rowElement(key: string): HTMLElement | null {
    return listElement()?.querySelector<HTMLElement>(`[data-pr-key="${CSS.escape(key)}"]`) ?? null;
}

function moveCursorTo(key: string | null): void {
    setPullRequestCursor(key);
    if (key) rowElement(key)?.scrollIntoView({block: 'nearest'});
}

/**
 * Give the list the keyboard, with the cursor on the PR on screen or the
 * first row: what Cmd+L does while the sidebar shows this page.
 */
export function focusPullRequestList(): void {
    const list = listElement();
    if (!list || getState().toolbar.sidebarCollapsed) return;
    list.focus({preventScroll: true});
    const repos = currentList();
    moveCursorTo(startListKey(repos, onScreenRowKey(repos)));
}

/** ↑/↓, J/K. */
export function stepPullRequestCursor(step: 1 | -1): void {
    moveCursorTo(stepListKey(listKeys(currentList()), getState().sidebarPrs.cursor, step));
}

/** The row the cursor is on, while it is still in the list. */
export function cursorRow(): PullRequestListRow | null {
    return findListRow(currentList(), getState().sidebarPrs.cursor);
}

/**
 * L on the cursor's row: Land it, the rocket from its button when it shows,
 * else from the row itself.
 */
export function landCursorRow(): void {
    const row = cursorRow();
    if (!row?.land) return;
    const element = rowElement(row.key);
    const button = element?.querySelector('.land-it');
    const shows = button && button.getBoundingClientRect().width > 0;
    landPullRequestRow(row, (shows ? button : element) ?? undefined);
}

/** Escape: the cursor gone and the keys back with the terminal on screen. */
export function leavePullRequestList(): void {
    setPullRequestCursor(null);
    const onScreen = highlightedSession(getState().mainArea);
    const open = onScreen ? openSessions.get(onScreen) : undefined;
    if (open) open.terminal.focus();
    else listElement()?.blur();
}
