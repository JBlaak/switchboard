import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    failedPullRequest,
    NO_QUEUE_MARK,
    queueChangeSignature,
    retriedPullRequest,
    sessionQueueFailure,
    sessionQueueMark,
} from '../src/domain/project/queue-elsewhere';
import {ERRAND_LABEL} from '../src/domain/project/queue-errands';
import type {SessionPullRequest} from '../src/domain/session/session';
import {
    errand,
    failed,
    head,
    held,
    MIN,
    NOW,
    prUrl,
    queued,
    queueOf,
    queuePr,
    REPO,
} from './support/merge-queue-fixtures';
import {QUEUE_LABELS} from '../src/domain/project/merge-queue';

const link = (number: number, repository = REPO): SessionPullRequest => ({
    number,
    url: prUrl(number, repository),
    repository,
});

const QUEUE = queueOf([head(1), queued(2, 2), held(3, 'sam'), failed(4)]);
const QUEUES = {[REPO]: QUEUE};

// ── The sidebar row ──

test('a session row gets the short pill of its PR’s place in the queue, with the sentence as its tooltip', () => {
    /* Given */
    const rows = [[link(1)], [link(2)], [link(3)], [link(4)]];

    /* When */
    const marks = rows.map((prs) => sessionQueueMark('s', prs, QUEUES, {}));

    /* Then */
    assert.deepEqual(
        marks.map((mark) => [mark.pill?.kind, mark.pill?.text]),
        [
            ['merging', 'merging'],
            ['queued', '2nd'],
            ['held', 'held'],
            ['failed', 'failed'],
        ],
    );
    assert.equal(marks[2].pill?.title, QUEUE.pills[3].title);
    assert.match(marks[2].pill?.title ?? '', /@sam/);
    assert.equal(marks[0].errand, null);
});

test('a row whose PRs the queue does not know, or in a repository without a queue, gets nothing at all', () => {
    /* Given */
    const elsewhere = link(2, 'o/other');
    const linkedNoRepo = {number: 99, url: prUrl(99), repository: ''};

    /* When */
    const marks = [
        sessionQueueMark('s', [], QUEUES, {}),
        sessionQueueMark('s', [elsewhere], QUEUES, {}),
        sessionQueueMark('s', [linkedNoRepo], QUEUES, {}),
    ];

    /* Then */
    for (const mark of marks) assert.strictEqual(mark, NO_QUEUE_MARK);
});

test('with several PRs, the newest one in the queue gives the pill; the repository comes from the URL when the link left it out', () => {
    /* Given */
    const prs = [link(2), {number: 4, url: prUrl(4), repository: ''}, link(50)];

    /* When */
    const mark = sessionQueueMark('s', prs, QUEUES, {});

    /* Then */
    assert.equal(mark.pill?.kind, 'failed');
});

test('an errand’s session is marked as one until its errand is done', () => {
    /* Given */
    const errands = {[REPO]: [errand('s7'), errand('s8', {state: 'done'}), errand('s9', {state: 'needs-you'})]};

    /* When */
    const running = sessionQueueMark('s7', [], QUEUES, errands);
    const done = sessionQueueMark('s8', [], QUEUES, errands);
    const needsYou = sessionQueueMark('s9', [link(4)], QUEUES, errands);

    /* Then */
    assert.deepEqual(running, {pill: null, errand: ERRAND_LABEL});
    assert.strictEqual(done, NO_QUEUE_MARK);
    assert.equal(needsYou.errand, 'errand · archives itself');
    assert.equal(needsYou.pill?.kind, 'failed');
});

// ── The session header ──

test('the header panel shows when the session’s own PR is out of the queue, naming the check', () => {
    /* Given */
    const prs = [link(2), link(4)];

    /* When */
    const failure = sessionQueueFailure(prs, QUEUES);

    /* Then */
    assert.ok(failure);
    assert.equal(failure.repository, REPO);
    assert.equal(failure.number, 4);
    assert.equal(failure.heading, '#4 left the queue');
    assert.equal(failure.summary, 'Unit tests failed as the head of the queue');
    assert.deepEqual(failedPullRequest(failure), {number: 4, title: 'PR 4', url: prUrl(4), headRef: 'branch-4'});
});

test('a stack failed on a member is fixed on the member, and retried on the labelled PR that carries automerge:failed', () => {
    /* Given */
    const bottom = queuePr(10, {headRef: 'a', labels: [QUEUE_LABELS.withStack]});
    const top = queuePr(12, {
        headRef: 'c',
        baseRef: 'a',
        labels: [QUEUE_LABELS.optIn, QUEUE_LABELS.failed],
        automerge: {state: 'failure', description: '#10: CI failed: Unit tests'},
    });
    const failure = sessionQueueFailure([link(10)], {[REPO]: queueOf([bottom, top])});
    assert.ok(failure);

    /* When */
    const fixed = failedPullRequest(failure).number;
    const retried = retriedPullRequest(failure);

    /* Then */
    assert.equal(failure.number, 10);
    assert.equal(fixed, 10);
    assert.equal(retried, 12);
});

test('no panel for a session whose PRs are queued, held, merging or unknown, or without a queue read', () => {
    /* Given */
    const prs = [link(1), link(2), link(3), link(77)];

    /* When */
    const withQueue = sessionQueueFailure(prs, QUEUES);
    const withoutQueue = sessionQueueFailure([link(4)], {});

    /* Then */
    assert.equal(withQueue, null);
    assert.equal(withoutQueue, null);
});

test('a failure without a named check says the queue’s reason', () => {
    /* Given */
    const conflict = queueOf([
        failed(4),
        {
            ...failed(5),
            automerge: {state: 'failure', description: 'Conflicts with main'},
            checks: [],
        },
    ]);

    /* When */
    const failure = sessionQueueFailure([link(5)], {[REPO]: conflict});

    /* Then */
    assert.equal(failure?.summary, 'Conflicts with main');
    assert.equal(failure?.entry.kind, 'conflict');
});

// ── When a push is due ──

test('a queue that only counted its estimates down has the same signature; a moved one does not', () => {
    /* Given */
    const now = queueOf([head(1), queued(2, 2)], NOW);
    const later = queueOf([head(1), queued(2, 2)], NOW + 2 * MIN);
    const moved = queueOf([head(2)], NOW + 2 * MIN);

    /* When */
    const signatures = [now, later, moved].map((queue) => queueChangeSignature(queue, []));

    /* Then */
    assert.notEqual(now.head?.estimateMs, later.head?.estimateMs);
    assert.equal(signatures[0], signatures[1]);
    assert.notEqual(signatures[1], signatures[2]);
    assert.notEqual(queueChangeSignature(now, [errand('s1')]), signatures[0]);
});
