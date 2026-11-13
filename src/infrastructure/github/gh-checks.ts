/**
 * A check on a PR's head commit as GitHub's GraphQL answers it (a `CheckRun`
 * or a commit `StatusContext`), mapped onto the four states Switchboard shows.
 */
import type {CheckRun} from '../../domain/session-work/model';

export function toCheck(node: any): CheckRun {
    if (node.__typename === 'StatusContext') {
        const state: CheckRun['state'] =
            node.state === 'SUCCESS'
                ? 'passing'
                : node.state === 'PENDING' || node.state === 'EXPECTED'
                  ? 'pending'
                  : 'failing';
        return withUrl({name: node.context ?? '', state}, node.targetUrl);
    }
    let state: CheckRun['state'];
    if (node.status !== 'COMPLETED') state = 'pending';
    else if (node.conclusion === 'SUCCESS' || node.conclusion === 'NEUTRAL') state = 'passing';
    else if (node.conclusion === 'SKIPPED') state = 'skipped';
    // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE:
    // someone has to act on each.
    else state = 'failing';
    return withUrl({name: node.name ?? '', state}, node.detailsUrl);
}

function withUrl(check: CheckRun, url: unknown): CheckRun {
    if (typeof url === 'string' && url) check.url = url;
    return check;
}
