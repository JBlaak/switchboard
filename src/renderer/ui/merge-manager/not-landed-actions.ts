/**
 * Not landed: what the Merge manager's section and its Not landed page do.
 * Read your open PRs from main (as the page opens, as the lanes change while
 * it is open, and as the Not landed page opens), switch between the lanes
 * and the Not landed page (View all, Esc), pick a project chip, Land it, and
 * open the session that opened a PR (found as the lanes' rows find theirs).
 *
 * A Land it goes through `landPullRequest` like every other Land it: the
 * rocket, the toast, and the PR leaving Not landed as main pushes the lanes.
 */
import {dispatch, getState} from '../../state/app-store';
import {landBusy} from '../../state/merge-manager-slice';
import {landPullRequest} from './land-actions';
import {openRowOnGitHub, sessionOf, stepMergeRow} from './page-actions';
import {jumpToSession} from '../session-work/plan/actions';
import {notLandedKey, type OpenPullRequest} from '../../../domain/merge-manager/not-landed';
import type {NotLandedKeyAction} from './page-keys';

/** Ask main for your open PRs; a failed read keeps what was there, and says it failed. */
export async function loadNotLanded(): Promise<void> {
    try {
        dispatch({type: 'mergeManagerNotLandedLoaded', ...(await window.api.mergeManagerNotLanded())});
    } catch {
        // The next change asks again.
        dispatch({type: 'mergeManagerNotLandedLoaded', pullRequests: null, fetchedAt: null, failed: true});
    }
}

/** View all: the Not landed page, read afresh. */
export function openNotLandedPage(): void {
    dispatch({type: 'mergeManagerViewChanged', view: 'notLanded'});
    void loadNotLanded();
}

/** Back to the lanes. */
export function closeNotLandedPage(): void {
    dispatch({type: 'mergeManagerViewChanged', view: 'lanes'});
}

/** A project chip; null is All. */
export function filterNotLanded(repository: string | null): void {
    dispatch({type: 'mergeManagerNotLandedFiltered', repository});
}

/** Land it on a Not landed row, the rocket from `from` when given. */
export function landNotLanded(pr: OpenPullRequest, from?: Element): Promise<void> {
    return landPullRequest(pr.repository, pr.number, from);
}

/** ⏎ or Open session: the newest session, not archived, that opened the PR. */
export async function openNotLandedSession(pr: OpenPullRequest): Promise<void> {
    const owner = sessionOf(pr);
    if (owner && (await jumpToSession(owner))) return;
    dispatch({type: 'mergeManagerPageNoticed', notice: `No session in the list opened #${pr.number}.`});
}

/** L on the selected row: Land it, the rocket from its Land it button on the page; nothing while one is under way. */
export function landNotLandedFromKey(pr: OpenPullRequest, page: Element | null): void {
    if (landBusy(getState().mergeManager, pr.repository, pr.number)) return;
    const button = page?.querySelector(`[data-land-key="${CSS.escape(notLandedKey(pr))}"]`) ?? undefined;
    void landNotLanded(pr, button);
}

/** What a key on a Not landed row asks for (`notLandedKeyAction`), carried out; `page` is where its buttons are. */
export function carryOutNotLandedKey(action: NotLandedKeyAction, page: Element | null): void {
    switch (action.kind) {
        case 'step':
            stepMergeRow(action.step);
            break;
        case 'land':
            landNotLandedFromKey(action.pr, page);
            break;
        case 'open':
            void openNotLandedSession(action.pr);
            break;
        case 'github':
            openRowOnGitHub(action.pr);
            break;
    }
}
