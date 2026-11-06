/**
 * What a running session asks of the user right now: its status tone.
 *
 * A session that waits for the user waits in one of two ways, and they ask
 * different things:
 *
 *   blocked     Claude cannot go on until the user answers: a permission
 *               prompt, a question, the trust prompt.
 *   your-turn   Claude replied and its turn ended. Nothing is stuck; the user
 *               reads the answer when they get to it.
 *
 * And a session that is not waiting is one of:
 *
 *   working     a turn is in flight, or the turn ended with background work
 *               (a build, a test run, an agent) that will wake it again.
 *   merging     its turn ended with only watches running (shells that wait on
 *               GitHub) and its open pull requests will land on their own:
 *               nobody needs to do anything, so it stays out of the way.
 *
 * A turn that ends with only watches is the user's turn, not working: it
 * pushed, reported and handed back, and GitHub does the rest (see
 * `background-tasks`). Unless its pull requests all land on their own, when
 * it is merging.
 */
import {pullRequestRepository, sidebarPill} from '../project/queue-elsewhere';
import type {MergeQueue} from '../project/merge-queue';
import type {PullRequestStatusChange} from '../session-work/status';
import type {TurnHolds} from './background-tasks';
import type {SessionPullRequest} from './session';

export type StatusTone = 'blocked' | 'your-turn' | 'working' | 'merging';

/** What is known of one session, as far as its tone cares. */
export interface ToneSignals {
    /** Blocked on the user: a prompt in the terminal, or questions asked. */
    needsAttention: boolean;
    /** Claude finished a turn the user hasn't looked at. */
    responseReady: boolean;
    /** A CLI turn is in flight. */
    busy: boolean;
    /** A row invented before Claude wrote its transcript. */
    pending: boolean;
    /** A PTY is running under this id. */
    hasLivePty: boolean;
    /** What the last turn's background tasks keep going; none when unknown. */
    holds?: TurnHolds;
    /** Its open pull requests all land on their own (`pullRequestsLand`). */
    landing?: boolean;
}

/** The session's tone; null for one that is not running and asks nothing. */
export function statusTone(signals: ToneSignals): StatusTone | null {
    if (signals.needsAttention) return 'blocked';
    if (signals.busy) return 'working';
    if (signals.hasLivePty && signals.holds === 'work') return 'working';
    if (signals.hasLivePty && signals.holds === 'watches' && signals.landing === true) return 'merging';
    if (signals.responseReady) return 'your-turn';
    // A pending row is starting up while a PTY runs under it; once that is gone
    // it is a placeholder awaiting cleanup.
    if (signals.pending && signals.hasLivePty) return 'working';
    // A live session that isn't spinning has ended its turn, read or not.
    if (signals.hasLivePty) return 'your-turn';
    return null;
}

/**
 * Whether a session's open pull requests all land on their own: each is in
 * its repository's merge queue (queued or merging, not held or failed) or has
 * GitHub's auto-merge on, and none is failing or waits on the user. Merged
 * and closed ones have nothing left to land. False when it has no open one,
 * or when the CI watch has not said how one is doing.
 */
export function pullRequestsLand(
    prs: readonly SessionPullRequest[],
    status: PullRequestStatusChange | undefined,
    queues: Readonly<Record<string, MergeQueue>>,
): boolean {
    if (!status || status.needsYou) return false;
    let open = 0;
    for (const pr of prs) {
        const known = status.prs.find((candidate) => candidate.number === pr.number);
        if (!known) return false;
        if (known.dot === 'merged' || known.closed === true) continue;
        open++;
        if (known.dot === 'red') return false;
        const queue = queues[pullRequestRepository(pr)];
        const pill = queue ? sidebarPill(queue, pr.number) : null;
        const queued = pill?.kind === 'queued' || pill?.kind === 'merging';
        if (!queued && known.autoMerge !== true) return false;
    }
    return open > 0;
}
