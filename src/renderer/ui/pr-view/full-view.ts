/**
 * The full view of a pull request: the work page with its diff, review
 * threads and your review. Owned by the full-view piece; the peek calls it.
 */
import type {PullRequestRef} from '../../../domain/session-work/pull-request-link';

/** Open the full view of a PR (stub: implemented by the full-view piece). */
export async function openPullRequestFullView(_ref: PullRequestRef, _url: string): Promise<void> {
    throw new Error('not implemented');
}
