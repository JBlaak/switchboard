/**
 * Which sessions opened a pull request: the ones whose work page is the PR's
 * full view, before it falls back on a page of its own.
 */
import {parsePullRequestUrl, samePullRequest} from '../../../domain/session-work/pull-request-link';
import type {PullRequestRef} from '../../../domain/session-work/pull-request-link';
import type {SessionPullRequest, SessionRow} from '../../../domain/session/session';

/**
 * The sessions whose PRs include `ref`, the most recently active first: the
 * one most likely still working on it, and so the one to show.
 *
 * A session's PR is matched by its URL where that is a github.com PR (the
 * transcript's URL may name another page of it, or differ in case), else by
 * its repository and number — never by number alone, which every repository
 * shares.
 */
export function pullRequestOwners(sessions: Iterable<SessionRow>, ref: PullRequestRef): string[] {
    const owners: SessionRow[] = [];
    for (const session of sessions) {
        if (session.pullRequests?.some((pr) => isPullRequest(pr, ref))) owners.push(session);
    }
    return owners.sort((a, b) => lastActive(b) - lastActive(a)).map((session) => session.sessionId);
}

function isPullRequest(pr: SessionPullRequest, ref: PullRequestRef): boolean {
    const own = parsePullRequestUrl(pr.url) ?? (pr.repository ? {repository: pr.repository, number: pr.number} : null);
    return own !== null && samePullRequest(own, ref);
}

/** When the session was last written to; an unreadable time counts as long ago. */
function lastActive(session: SessionRow): number {
    const at = Date.parse(session.modified);
    return Number.isNaN(at) ? 0 : at;
}
