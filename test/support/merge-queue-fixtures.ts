/**
 * Merge queues for the tests of the queue outside the project page (#315),
 * built through the domain's own `mergeQueue` from PRs as the queue labels them.
 */
import {mergeQueue, QUEUE_LABELS, type MergeQueue, type QueuePullRequest} from '../../src/domain/project/merge-queue';
import type {QueueErrandView} from '../../src/domain/project/queue-errands';

export const REPO = 'o/app';
export const MIN = 60_000;
export const NOW = Date.parse('2026-11-04T14:00:00Z');

export const prUrl = (number: number, repository = REPO) => `https://github.com/${repository}/pull/${number}`;

export function queuePr(number: number, fields: Partial<QueuePullRequest> = {}): QueuePullRequest {
    return {
        number,
        title: 'PR ' + number,
        url: prUrl(number),
        headRef: 'branch-' + number,
        baseRef: 'main',
        draft: false,
        labels: [QUEUE_LABELS.optIn],
        automerge: null,
        review: 'approved',
        requestedReviewers: [],
        approvedBy: ['reviewer'],
        checks: [],
        ...fields,
    };
}

export function head(number: number, running = true): QueuePullRequest {
    return queuePr(number, {
        labels: [QUEUE_LABELS.optIn, QUEUE_LABELS.head],
        automerge: {state: 'pending', description: 'First in the merge queue; merges once CI passes'},
        checks: running ? [{name: 'Unit tests', state: 'running', startedAt: NOW - 5 * MIN}] : [],
    });
}

export function queued(number: number, position: number): QueuePullRequest {
    return queuePr(number, {automerge: {state: 'pending', description: `Number ${position} in the merge queue`}});
}

export function held(number: number, reviewer: string): QueuePullRequest {
    return queuePr(number, {automerge: {state: 'pending', description: `Waits for a review by @${reviewer}`}});
}

export function failed(number: number, check = 'Unit tests'): QueuePullRequest {
    return queuePr(number, {
        labels: [QUEUE_LABELS.failed],
        automerge: {state: 'failure', description: 'CI failed: ' + check},
        checks: [{name: check, state: 'failed', startedAt: NOW - 30 * MIN}],
    });
}

export function queueOf(pullRequests: QueuePullRequest[], now = NOW): MergeQueue {
    return mergeQueue({trunk: 'main', pullRequests, ciRunDurationsMs: [20 * MIN, 22 * MIN, 24 * MIN], now});
}

export function errand(sessionId: string | null, fields: Partial<QueueErrandView> = {}): QueueErrandView {
    return {
        id: 'e-' + sessionId,
        kind: 'fix',
        repository: REPO,
        number: 9,
        title: 'PR 9',
        url: prUrl(9),
        reviewer: null,
        message: null,
        sessionId,
        createdAt: NOW,
        settledAt: null,
        state: 'running',
        ...fields,
    };
}
