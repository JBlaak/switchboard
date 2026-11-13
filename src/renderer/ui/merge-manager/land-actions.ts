/**
 * Land it and Unland (#436): what the four places that offer them do.
 *
 * Landing asks main (`mergeManagerLand`), which refuses a PR that is not the
 * user's own, open and ready; its answer brings the toast ("Landed #432 · 2nd
 * in switchboard's lane", with Undo) or says why not. Main pushes the lanes
 * after either (`mergeManagerChanged`), which turns every place's button into
 * the PR's stage.
 */
import {dispatch, getState} from '../../state/app-store';
import {sessionMap} from '../../state/session-store';
import {landOffer, sessionLandCandidate} from '../../../domain/merge-manager/land-it';
import type {LinkedPr} from '../../../domain/session/links';

/** Hand a PR to the Merge manager. */
export async function landPullRequest(repository: string, number: number): Promise<void> {
    dispatch({type: 'landStarted', repository, number, action: 'land'});
    try {
        const result = await window.api.mergeManagerLand(repository, number);
        dispatch({
            type: 'landFinished',
            repository,
            number,
            action: 'land',
            result: result.ok ? {ok: true, landed: result.landed} : result,
        });
    } catch (err) {
        dispatch({type: 'landFinished', repository, number, action: 'land', result: failed(err)});
    }
}

/** Take a landed PR back out of its lane. Running CI and errands are left alone. */
export async function unlandPullRequest(repository: string, number: number): Promise<void> {
    dispatch({type: 'landStarted', repository, number, action: 'unland'});
    try {
        const result = await window.api.mergeManagerUnland(repository, number);
        dispatch({
            type: 'landFinished',
            repository,
            number,
            action: 'unland',
            result: result.ok ? {ok: true, landed: null} : {ok: false, reason: result.reason},
        });
    } catch (err) {
        dispatch({type: 'landFinished', repository, number, action: 'unland', result: failed(err)});
    }
}

/** The toast's Undo: unland the PR it landed, and put the toast away. */
export function undoLand(): void {
    const toast = getState().mergeManager.toast;
    if (toast?.kind !== 'landed') return;
    dispatch({type: 'landToastClosed', id: toast.id});
    void unlandPullRequest(toast.repository, toast.number);
}

export function closeLandToast(id: number): void {
    dispatch({type: 'landToastClosed', id});
}

/** Ask main for a session's PRs as `gh` reads them, for its Land it; none when main could not say. */
export async function loadSessionPullRequests(sessionId: string): Promise<readonly LinkedPr[]> {
    let pullRequests: LinkedPr[];
    try {
        const links = await window.api.getSessionLinks(sessionId);
        pullRequests = links.filter((link): link is LinkedPr => link.kind === 'pr');
    } catch {
        return getState().mergeManager.sessionPullRequests[sessionId] ?? [];
    }
    dispatch({type: 'sessionPullRequestsLoaded', sessionId, pullRequests});
    return pullRequests;
}

/**
 * L on a sidebar row: land the session's newest open PR. Its PRs are read
 * first when they have not been, so a draft or a teammate's PR says why it
 * does not land rather than asking main.
 */
export async function landSessionPullRequest(sessionId: string): Promise<void> {
    const known = getState().mergeManager.sessionPullRequests[sessionId];
    const prs = known ?? (await loadSessionPullRequests(sessionId));
    const candidate = sessionLandCandidate(prs);
    if (!candidate) {
        // `gh` could not say: the transcript's newest PR, which main judges.
        const newest = sessionMap.get(sessionId)?.pullRequests?.at(-1);
        if (newest?.repository) return landPullRequest(newest.repository, newest.number);
        return refuse(0, 'this session has no pull request to land');
    }
    const offer = landOffer(candidate, getState().mergeManager.state);
    switch (offer?.kind) {
        case 'land':
            return landPullRequest(candidate.repository, candidate.number);
        case 'draft':
            return refuse(candidate.number, offer.hint);
        case 'landed':
            // Already landed: the toast says where it stands.
            dispatch({
                type: 'landFinished',
                repository: candidate.repository,
                number: candidate.number,
                action: 'land',
                result: {ok: true, landed: offer.landed},
            });
            return;
        default:
            return refuse(
                candidate.number,
                candidate.mine ? `#${candidate.number} is ${candidate.state}` : 'only your own pull requests land',
            );
    }
}

function refuse(number: number, reason: string): void {
    dispatch({type: 'landFinished', repository: '', number, action: 'land', result: {ok: false, reason}});
}

function failed(err: unknown): {ok: false; reason: string} {
    return {ok: false, reason: err instanceof Error ? err.message : String(err)};
}
