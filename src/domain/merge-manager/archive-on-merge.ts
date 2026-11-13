/**
 * Archiving a landed PR's session once it merged (#440, for #432).
 *
 * The session that opened the PR has done its job when the PR merges, so the
 * Merge manager archives it:
 *
 * - **idle**: right away;
 * - **busy** (a turn running): at the end of that turn, so it is not cut off
 *   mid-reply;
 * - **dirty** (uncommitted changes in a worktree it worked in): never, since
 *   archiving may remove the worktree and those changes with it. It stays,
 *   and its row shows Merged until the user archives it.
 *
 * Uncommitted changes are looked at again when a deferred turn ends: the turn
 * may have left some.
 */
import {landedKey} from './model';

export type MergedSessionVerdict = 'archive' | 'defer' | 'keep';

/** Whether a merged PR's session is archived now, at the end of its turn, or not at all. */
export function mergedSessionVerdict(session: {busy: boolean; dirty: boolean}): MergedSessionVerdict {
    if (session.dirty) return 'keep';
    return session.busy ? 'defer' : 'archive';
}

/** A PR a session opened, as its row knows it. */
export interface SessionPullRequestRef {
    readonly number: number;
    readonly url: string;
    /** `owner/repo`; '' when the transcript did not say. */
    readonly repository: string;
}

/** A PR as the Merge manager keys it. */
export interface MergedPullRequestRef {
    readonly repository: string;
    readonly number: number;
    readonly url: string;
}

/** Does the session's PR stand for the merged one? By repository and number, or by URL when the repository is unknown. */
export function isSamePullRequest(pr: SessionPullRequestRef, merged: MergedPullRequestRef): boolean {
    if (pr.number !== merged.number) return false;
    if (pr.repository) return landedKey(pr.repository, pr.number) === landedKey(merged.repository, merged.number);
    return pr.url.toLowerCase().replace(/\/+$/, '') === merged.url.toLowerCase().replace(/\/+$/, '');
}

/** The sessions, not archived, that opened any of the `merged` PRs. */
export function sessionsOfMerged<S extends {archived?: boolean; pullRequests: readonly SessionPullRequestRef[]}>(
    sessions: readonly S[],
    merged: readonly MergedPullRequestRef[],
): S[] {
    return sessions.filter(
        (session) =>
            !session.archived && session.pullRequests.some((pr) => merged.some((m) => isSamePullRequest(pr, m))),
    );
}
