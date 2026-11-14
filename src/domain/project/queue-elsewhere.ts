/**
 * The merge queue outside the project page (#315): what a sidebar row and a
 * session's header make of a repository's queue.
 *
 * Main reads the queue of every repository a running session is in, whether
 * or not its project page is open, and pushes it (`MergeQueueChange`) when it
 * changed. From it:
 *
 * - a session row whose PR is in the queue gets a short pill (merging, 2nd,
 *   held, failed) with the queue's sentence as its tooltip, and an errand's
 *   session is marked as one (`sessionQueueMark`); a landed PR's pill says
 *   its Merge manager stage instead, in either lane (`stage-words`, #441);
 * - a session whose PR left the queue gets a panel over its terminal
 *   (`sessionQueueFailure`).
 *
 * Pure, so main and the renderer share it and the tests hold it still.
 */
import {ordinal} from '../merge-manager/stage-words';
import {ERRAND_LABEL, type QueueErrandView} from './queue-errands';
import type {FailedEntry, MergeQueue, QueueEntry} from './merge-queue';
import type {SessionPullRequest} from '../session/session';
import {EMPTY_MERGE_MANAGER_STATE, type LaneStageKind, type MergeManagerState} from '../merge-manager/model';
import {findLanded, landedWords} from '../merge-manager/stage-words';

/** What main pushes for one repository: its queue (null: it no longer uses one, or nothing runs in it) and its errands. */
export interface MergeQueueChange {
    /** `owner/repo`. */
    repository: string;
    queue: MergeQueue | null;
    errands: QueueErrandView[];
}

/**
 * What decides whether a push is due: the queue without its estimates, which
 * count down on every read, and the errands. The sidebar and the header show
 * no estimate, so a queue that only got closer to merging is not pushed.
 */
export function queueChangeSignature(queue: MergeQueue | null, errands: readonly QueueErrandView[]): string {
    if (!queue) return JSON.stringify({queue: null, errands});
    const head = queue.head ? {...queue.head, estimateMs: null} : null;
    const entries = queue.entries.map((entry) => ({...entry, estimateMs: null}));
    return JSON.stringify({queue: {...queue, head, entries, clearsInMs: null}, errands});
}

// ── A session's PRs ──

/** `owner/repo` of a PR link: as the transcript said, or from its URL; '' when neither says. */
export function pullRequestRepository(pr: SessionPullRequest): string {
    if (pr.repository) return pr.repository;
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(pr.url);
    return match ? match[1] : '';
}

/** A session's PR links, newest first and one per URL, each with its repository. */
function newestFirst(prs: readonly SessionPullRequest[]): {pr: SessionPullRequest; repository: string}[] {
    const seen = new Set<string>();
    const out: {pr: SessionPullRequest; repository: string}[] = [];
    for (let i = prs.length - 1; i >= 0; i--) {
        const pr = prs[i];
        if (seen.has(pr.url)) continue;
        seen.add(pr.url);
        const repository = pullRequestRepository(pr);
        if (repository) out.push({pr, repository});
    }
    return out;
}

function hasMember(entry: QueueEntry, number: number): boolean {
    return entry.number === number || entry.members.some((member) => member.number === number);
}

// ── The sidebar row ──

/** The pill a session row shows for its PR's place in the queue, or its landed stage. */
export interface SidebarQueuePill {
    /** The queue's own kinds, or `landed-<stage>` for a landed PR. */
    kind: 'merging' | 'queued' | 'held' | 'failed' | `landed-${LaneStageKind}`;
    /** "merging", "2nd", "held", "failed"; for a landed PR "landed · 2nd", "held · @ana", "fixing", … */
    text: string;
    /** The queue's full sentence, or the landed stage's. */
    title: string;
    /** "will conflict" on a waiting landed PR that will; absent otherwise. */
    flag?: string | null;
}

/** The sidebar's pill for a landed PR: the stage words every place shares (#441). */
export function landedPill(merge: MergeManagerState, repository: string, number: number): SidebarQueuePill | null {
    const found = findLanded(merge, repository, number);
    if (!found) return null;
    const words = landedWords(found);
    return {kind: `landed-${words.kind}`, text: words.pill, title: words.title, flag: words.flag};
}

/** What a session row shows of the queue: its PR's pill, and whether the session is an errand. */
export interface SessionQueueMark {
    pill: SidebarQueuePill | null;
    /** "errand · archives itself", while the errand is not done; null for any other session. */
    errand: string | null;
}

export const NO_QUEUE_MARK: SessionQueueMark = {pill: null, errand: null};

/** The sidebar's pill for one PR of a queue; null when the PR is not in it (or only "kept rebased" and the like). */
export function sidebarPill(queue: MergeQueue, number: number): SidebarQueuePill | null {
    const pill = queue.pills[number];
    if (!pill) return null;
    switch (pill.kind) {
        case 'merging':
            return {kind: 'merging', text: 'merging', title: pill.title};
        case 'held':
            return {kind: 'held', text: 'held', title: pill.title};
        case 'failed':
            return {kind: 'failed', text: 'failed', title: pill.title};
        case 'queued': {
            const entry = queue.entries.find((candidate) => hasMember(candidate, number));
            const place = entry ? ordinal(entry.position) : (pill.text.split(' · ')[1] ?? 'queued');
            return {kind: 'queued', text: place, title: pill.title};
        }
        default:
            return null;
    }
}

/**
 * What a session row shows: the pill of its newest PR that is landed (its
 * stage) or in its repository's queue, and the errand marker when the
 * session is one that has not finished. Nothing at all for a session neither
 * knows anything of, so such a row renders exactly as it did before.
 */
export function sessionQueueMark(
    sessionId: string,
    prs: readonly SessionPullRequest[],
    queues: Readonly<Record<string, MergeQueue>>,
    errands: Readonly<Record<string, readonly QueueErrandView[]>>,
    merge: MergeManagerState = EMPTY_MERGE_MANAGER_STATE,
): SessionQueueMark {
    let pill: SidebarQueuePill | null = null;
    for (const {pr, repository} of newestFirst(prs)) {
        const queue = queues[repository];
        pill = landedPill(merge, repository, pr.number) ?? (queue ? sidebarPill(queue, pr.number) : null);
        if (pill) break;
    }
    const errand = Object.values(errands).some((list) =>
        list.some((candidate) => candidate.sessionId === sessionId && candidate.state !== 'done'),
    );
    if (!pill && !errand) return NO_QUEUE_MARK;
    return {pill, errand: errand ? ERRAND_LABEL : null};
}

// ── The session header ──

/** A session's PR that left the queue, as its header panel shows it. */
export interface SessionQueueFailure {
    repository: string;
    /** The PR of the session's that failed: the entry's own, or the stack member it is. */
    number: number;
    entry: FailedEntry;
    /** "#2262 left the queue". */
    heading: string;
    /** "Unit tests failed as the head of the queue", or the queue's reason. */
    summary: string;
}

/**
 * The panel over a session's terminal: shown when one of the session's own
 * PRs is in its repository's `failed` list, for the newest such PR; null
 * otherwise. A PR landed with the Merge manager is left out (`landed`): its
 * fix errand has it, and Fix in session or Retry would compete with it
 * (#437); the header's landed pill says where it is.
 */
export function sessionQueueFailure(
    prs: readonly SessionPullRequest[],
    queues: Readonly<Record<string, MergeQueue>>,
    landed: (repository: string, number: number) => boolean = () => false,
): SessionQueueFailure | null {
    for (const {pr, repository} of newestFirst(prs)) {
        const entry = queues[repository]?.failed.find((candidate) => hasMember(candidate, pr.number));
        if (!entry) continue;
        const number = entry.failedMember ?? entry.number;
        if (landed(repository, number)) continue;
        return {
            repository,
            number,
            entry,
            heading: `#${number} left the queue`,
            summary: entry.failingCheck ? `${entry.failingCheck} failed as the head of the queue` : entry.reason,
        };
    }
    return null;
}

/** The PR Fix in session and Open the run act on: a stack's failed member, or the entry's own PR. */
export function failedPullRequest(failure: SessionQueueFailure): {
    number: number;
    title: string;
    url: string;
    headRef: string;
} {
    const {entry} = failure;
    const member = entry.members.find((candidate) => candidate.number === failure.number);
    return member
        ? {number: member.number, title: member.title, url: member.url, headRef: member.headRef}
        : {number: entry.number, title: entry.title, url: entry.url, headRef: entry.headRef};
}

/**
 * The PR Retry takes `automerge:failed` off: the one carrying it, the
 * entry's labelled PR, also when the failure is on a stack member below it.
 */
export function retriedPullRequest(failure: SessionQueueFailure): number {
    return failure.entry.number;
}
