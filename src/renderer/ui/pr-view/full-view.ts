/**
 * The full view of a pull request: the work page with its diff, review
 * threads and your review. The peek opens it on request.
 *
 * A PR a session opened is shown on that session's own page, with the PR
 * selected, so its threads, actions and Claude are all at hand. A PR no
 * session opened — or whose sessions' pages cannot open here, a remote
 * session's for one — gets a page of its own (`pullRequestPageId`): the PR
 * alone, reviewed but never handed to Claude.
 */
import {sessionMap} from '../../state/session-store';
import {pullRequestPageId} from '../../../domain/session-work/pull-request-link';
import type {PullRequestRef} from '../../../domain/session-work/pull-request-link';
import {canOpenSessionWork, openSessionWork, openSessionWorkFromRow} from '../session-work/actions';
import {getState} from '../../state/app-store';
import {pullRequestOwners} from './owners';

/**
 * Open the full view of a PR. `url` is the link as it was met; the PR is
 * known by `ref` (see `parsePullRequestUrl`), which is what owners are
 * matched on.
 */
export async function openPullRequestFullView(ref: PullRequestRef, _url: string): Promise<void> {
    for (const sessionId of pullRequestOwners(sessionMap.values(), ref)) {
        const cached = getState().sessionWork.canOpen[sessionId];
        const canOpen = cached === true || (await canOpenSessionWork(sessionId, {fresh: cached === false}));
        if (canOpen && (await openSessionWorkFromRow(sessionId, {pullRequest: ref}))) return;
    }
    await openSessionWork(pullRequestPageId(ref), {pullRequest: ref});
}
