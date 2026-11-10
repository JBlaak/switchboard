/**
 * Every link in the app that may be a pull request comes through `openLink`.
 *
 * A github.com PR link — any page of it, `/files`, `/checks`, a comment
 * anchor — opens the peek: the PR's diff over whatever is on screen, asked
 * of `gh` through main. Anything else goes to the browser exactly as it did
 * before. One door, so a new place that shows links only has to call it to
 * get the same behaviour as the terminal, the Markdown and the rows.
 *
 * From the peek, Full view hands the PR to the full view (the work page) and
 * Open on GitHub sends the link as it was followed to the browser, so a
 * `/checks` link still lands on the Checks tab.
 */
import {dispatch, getState, onEvent} from '../../state/app-store';
import {parsePullRequestUrl} from '../../../domain/session-work/pull-request-link';
import type {PullRequestRef} from '../../../domain/session-work/pull-request-link';
import type {DiffMode} from '../../state/session-work-slice';
import {openPullRequestFullView} from './full-view';

/** Where a link goes: the peek for a PR, the browser for anything else. */
export type LinkRoute = {kind: 'peek'; ref: PullRequestRef} | {kind: 'external'};

export function routeLink(url: string): LinkRoute {
    const ref = parsePullRequestUrl(url);
    return ref ? {kind: 'peek', ref} : {kind: 'external'};
}

/** Follow a link: a PR's peek, or the browser. */
export function openLink(url: string): void {
    const route = routeLink(url);
    if (route.kind === 'peek') void openPullRequestPeek(route.ref, url);
    else void window.api.openExternal(url);
}

/** Tells one peek's answer from the next's. Never reused, so a closed peek's answer can't match. */
let lastPeekId = 0;

/** Open the peek on a PR and ask for its diff. `url` is what Open on GitHub opens. */
export async function openPullRequestPeek(ref: PullRequestRef, url: string): Promise<void> {
    const id = ++lastPeekId;
    dispatch({type: 'prPeekOpened', id, ref, url});
    try {
        const peek = await window.api.peekPullRequest(ref);
        dispatch({type: 'prPeekAnswered', id, peek});
    } catch (err) {
        dispatch({type: 'prPeekFailed', id, error: (err as Error)?.message || "Couldn't load the pull request"});
    }
}

export function closePullRequestPeek(): void {
    dispatch({type: 'prPeekClosed'});
}

/** ↵ or Full view: the peek gives way to the PR's full view. */
export function openPeekFullView(): void {
    const peek = getState().prPeek.peek;
    if (!peek) return;
    dispatch({type: 'prPeekClosed'});
    void openPullRequestFullView(peek.ref, peek.url).catch((err: Error) => {
        dispatch({type: 'statusUpdate', text: err.message || "Couldn't open the full view", kind: 'error'});
    });
}

/** `o` or Open on GitHub: the link as it was followed, in the browser. The peek stays. */
export function openPeekOnGitHub(): void {
    const peek = getState().prPeek.peek;
    if (peek) void window.api.openExternal(peek.url);
}

export function expandPeekFile(path: string): void {
    const peek = getState().prPeek.peek;
    if (peek) dispatch({type: 'prPeekFileExpanded', id: peek.id, path});
}

export function setPeekDiffMode(mode: DiffMode): void {
    dispatch({type: 'prPeekModeSet', mode});
}

/** `u`: Unified ⇄ Split. */
export function togglePeekDiffMode(): void {
    setPeekDiffMode(getState().prPeek.mode === 'unified' ? 'split' : 'unified');
}

/** A PR link main caught in the main window (a stray anchor) opens the peek too. */
export function installPullRequestPeek(): void {
    onEvent('pullRequestLinkOpened', (event) => openLink(event.url));
}
