/**
 * What a pull request on the project page waits on: the group the Pull
 * requests section lists it under, and its open point, what still needs
 * someone, in words ("CI failing: test", "2 unresolved threads", "behind
 * main", "waiting on review"), naming each reason when there are several.
 *
 * The groups, in the order the section shows them; a PR's group is the first
 * whose rule holds:
 *
 * - **Needs you**: its CI fails and no session linked to it is running; a
 *   review is requested from you; changes are requested; it conflicts; it is
 *   a draft; or the merge queue failed it.
 * - **Waiting on CI**: its CI runs, it is in the merge queue, or its CI fails
 *   while a linked session is on it. The merge queue cancels the CI of the
 *   PRs it holds behind its head and runs it again later: on a PR in the
 *   queue, CI that was only cancelled is no failure.
 * - **Waiting on review**: a review is required or requested from someone
 *   else, or a review thread is unresolved.
 * - **Ready to merge**: none of the above. Behind its base is said, but does
 *   not hold it back: GitHub updates the branch in one click.
 * - **Merged or closed today**: gone the next day. An older merged one is
 *   `merged-earlier`, listed only with Show merged.
 *
 * An author's note, a review thread a Claude Code session starts on its own
 * PR to explain a change, asks nothing of anyone: it is no unresolved thread
 * until someone replies in it.
 */
import type {CheckRollup, ReviewDecision} from './overview';

/** The section's groups, in the order it shows them. */
export const PULL_REQUEST_GROUPS = [
    'needs-you',
    'waiting-on-ci',
    'waiting-on-review',
    'ready-to-merge',
    'merged-or-closed-today',
    'merged-earlier',
] as const;
export type PullRequestGroup = (typeof PULL_REQUEST_GROUPS)[number];

/** Each group's heading. */
export const PULL_REQUEST_GROUP_TITLES: Record<PullRequestGroup, string> = {
    'needs-you': 'Needs you',
    'waiting-on-ci': 'Waiting on CI',
    'waiting-on-review': 'Waiting on review',
    'ready-to-merge': 'Ready to merge',
    'merged-or-closed-today': 'Merged or closed today',
    'merged-earlier': 'Merged earlier',
};

/** What the rules are told of a pull request. */
export interface PullRequestWaitFacts {
    state: 'open' | 'merged' | 'closed';
    /** Merged or closed on today's (local) date. */
    closedToday: boolean;
    draft: boolean;
    checks: CheckRollup;
    /** The names of the check runs that failed on its head commit, cancelled ones included. */
    failedChecks: readonly string[];
    /** Those of `failedChecks` that were cancelled. */
    cancelledChecks: readonly string[];
    review: ReviewDecision;
    reviewRequestedFromYou: boolean;
    /** A review is requested from a user other than you. */
    reviewRequestedFromOthers: boolean;
    /** Unresolved review threads, author's notes nobody replied in left out (`unresolvedThreadCount`). */
    unresolvedThreads: number;
    mergeable: 'mergeable' | 'conflicting' | 'unknown';
    /** The branch it merges into, when it is behind it; null when it is not, or GitHub cannot say. */
    behindBase: string | null;
    /**
     * Its place in the merge queue: `queued` while the queue holds it on its
     * way in, `failed` once the queue gave up on it; null out of the queue.
     */
    queue: 'queued' | 'failed' | null;
    /** A session linked to it is running: its worktree's branch is the PR's head, or it owns an issue the PR closes. */
    sessionWorking: boolean;
}

export interface PullRequestWait {
    group: PullRequestGroup;
    /** What still needs someone, in words; empty when nothing does. */
    openPoint: string;
}

/** How many failed checks the open point names before it counts the rest. */
const NAMED_CHECKS = 3;

export function pullRequestWait(pr: PullRequestWaitFacts): PullRequestWait {
    if (pr.state !== 'open') {
        return {group: pr.closedToday ? 'merged-or-closed-today' : 'merged-earlier', openPoint: pr.state};
    }

    const onlyCancelled =
        pr.failedChecks.length > 0 && pr.failedChecks.every((name) => pr.cancelledChecks.includes(name));
    const ciFailing = pr.checks.state === 'failing' && !(pr.queue !== null && onlyCancelled);
    const ciRunning = pr.checks.state === 'running';
    const waitingOnOthers = pr.review === 'review_required' && !pr.reviewRequestedFromYou;
    const waitingOnReview = waitingOnOthers || pr.reviewRequestedFromOthers;

    const needsYou: string[] = [];
    if (ciFailing && !pr.sessionWorking) needsYou.push(failedText(pr.failedChecks));
    if (pr.reviewRequestedFromYou) needsYou.push('waiting on your review');
    if (pr.review === 'changes_requested') needsYou.push('changes requested');
    if (pr.mergeable === 'conflicting') needsYou.push('conflict');
    if (pr.draft) needsYou.push('draft');
    if (pr.queue === 'failed' && needsYou.length === 0 && !ciFailing) needsYou.push('merge queue failed');

    const points = [
        ...(ciFailing && pr.sessionWorking ? [failedText(pr.failedChecks) + ' (a session is on it)'] : []),
        ...(ciRunning ? ['CI running'] : []),
        ...needsYou,
        ...(pr.unresolvedThreads > 0 ? [threads(pr.unresolvedThreads)] : []),
        ...(pr.behindBase ? ['behind ' + pr.behindBase] : []),
        ...(waitingOnReview && pr.unresolvedThreads === 0 && !pr.reviewRequestedFromYou ? ['waiting on review'] : []),
    ];
    const openPoint = points.join(' · ');

    if (needsYou.length > 0) return {group: 'needs-you', openPoint};
    if (ciRunning || pr.queue === 'queued' || ciFailing) return {group: 'waiting-on-ci', openPoint};
    if (waitingOnReview || pr.unresolvedThreads > 0) return {group: 'waiting-on-review', openPoint};
    return {group: 'ready-to-merge', openPoint};
}

function failedText(names: readonly string[]): string {
    if (names.length === 0) return 'CI failing';
    const named = names.slice(0, NAMED_CHECKS).join(', ');
    return 'CI failing: ' + named + (names.length > NAMED_CHECKS ? ' +' + (names.length - NAMED_CHECKS) : '');
}

function threads(count: number): string {
    return count + ' unresolved thread' + (count === 1 ? '' : 's');
}

// ── Author's notes ──

/** A review thread as the rules read it: resolved or not, how many comments, and its first one's text. */
export interface ReviewThreadFacts {
    resolved: boolean;
    comments: number;
    firstComment: string;
}

/**
 * The header a Claude Code session opens an author's note with, quoted or
 * not, its apostrophe straight or typographic.
 */
const AUTHORS_NOTE = /^(?:>\s*)?🤖\s*\*\*Claude Code\*\*\s*·\s*author['’]s note\b/;

/** Whether a comment is an author's note: it opens with the header. */
export function isAuthorsNote(body: string): boolean {
    return AUTHORS_NOTE.test(body);
}

/** The unresolved threads, an author's note nobody replied in not counted. */
export function unresolvedThreadCount(threads: readonly ReviewThreadFacts[]): number {
    return threads.filter((thread) => !thread.resolved && !(thread.comments <= 1 && isAuthorsNote(thread.firstComment)))
        .length;
}
