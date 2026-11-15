/**
 * Not landed: what the Merge manager's section and its Not landed page do.
 * Read your open PRs from main (as the page opens, as the lanes change while
 * it is open, and as the Not landed page opens), switch between the lanes
 * and the Not landed page (View all, Esc), pick a project chip, and Land it.
 *
 * A Land it goes through `landPullRequest` like every other Land it: the
 * rocket, the toast, and the PR leaving Not landed as main pushes the lanes.
 */
import {dispatch} from '../../state/app-store';
import {landPullRequest} from './land-actions';
import type {OpenPullRequest} from '../../../domain/merge-manager/not-landed';

/** Ask main for your open PRs; a failed read keeps what was there. */
export async function loadNotLanded(): Promise<void> {
    try {
        dispatch({type: 'mergeManagerNotLandedLoaded', pullRequests: await window.api.mergeManagerNotLanded()});
    } catch {
        // The next change asks again.
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
