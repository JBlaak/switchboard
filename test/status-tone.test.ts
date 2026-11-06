import {test} from 'node:test';
import assert from 'node:assert';
import {pullRequestsLand, statusTone, type ToneSignals} from '../src/domain/session/status-tone';
import type {MergeQueue, QueuePill} from '../src/domain/project/merge-queue';
import type {PullRequestDot, PullRequestStatusChange} from '../src/domain/session-work/status';
import type {SessionPullRequest} from '../src/domain/session/session';

const REPO = 'acme/app';

function signals(extra: Partial<ToneSignals> = {}): ToneSignals {
    return {needsAttention: false, responseReady: false, busy: false, pending: false, hasLivePty: true, ...extra};
}

function pr(number: number): SessionPullRequest {
    return {number, url: `https://github.com/${REPO}/pull/${number}`, repository: REPO};
}

function status(prs: PullRequestDot[], needsYou = false): PullRequestStatusChange {
    return {sessionId: 's', prs, needsYou};
}

function queue(pills: Record<number, QueuePill['kind']>): Record<string, MergeQueue> {
    const all: Record<number, QueuePill> = {};
    for (const [number, kind] of Object.entries(pills)) all[Number(number)] = {kind, text: kind, title: kind};
    const q: MergeQueue = {
        head: null,
        entries: [],
        failed: [],
        outside: [],
        unknown: [],
        counts: {queued: 0, held: 0, failed: 0},
        clearsInMs: null,
        runMs: null,
        pills: all,
    };
    return {[REPO]: q};
}

test('a session blocked on a prompt is blocked', () => {
    /* When */
    const tone = statusTone(signals({needsAttention: true}));

    /* Then */
    assert.strictEqual(tone, 'blocked');
});

test("a session whose turn ended is the user's turn", () => {
    /* When */
    const tone = statusTone(signals({responseReady: true}));

    /* Then */
    assert.strictEqual(tone, 'your-turn');
});

test('a session mid-turn is working', () => {
    /* When */
    const tone = statusTone(signals({busy: true}));

    /* Then */
    assert.strictEqual(tone, 'working');
});

test('a turn that ended with background work is still working', () => {
    /* When */
    const tone = statusTone(signals({responseReady: true, holds: 'work'}));

    /* Then */
    assert.strictEqual(tone, 'working');
});

test("a turn that ended with only watches is the user's turn", () => {
    /* When */
    const tone = statusTone(signals({responseReady: true, holds: 'watches'}));

    /* Then */
    assert.strictEqual(tone, 'your-turn');
});

test('a turn that ended with only watches and pull requests that land on their own is merging', () => {
    /* When */
    const tone = statusTone(signals({responseReady: true, holds: 'watches', landing: true}));

    /* Then */
    assert.strictEqual(tone, 'merging');
});

test('a turn that ended with no background tasks is never merging', () => {
    /* When */
    const tone = statusTone(signals({holds: 'none', landing: true}));

    /* Then */
    assert.strictEqual(tone, 'your-turn');
});

test('a question outranks merging', () => {
    /* When */
    const tone = statusTone(signals({needsAttention: true, holds: 'watches', landing: true}));

    /* Then */
    assert.strictEqual(tone, 'blocked');
});

test('a session without a process asks nothing', () => {
    /* When */
    const tone = statusTone(signals({hasLivePty: false, holds: 'work'}));

    /* Then */
    assert.strictEqual(tone, null);
});

test('a pull request in the merge queue lands on its own', () => {
    /* When */
    const lands = pullRequestsLand([pr(1)], status([{number: 1, dot: 'amber'}]), queue({1: 'queued'}));

    /* Then */
    assert.strictEqual(lands, true);
});

test('a pull request with auto-merge on lands on its own', () => {
    /* When */
    const lands = pullRequestsLand([pr(1)], status([{number: 1, dot: 'green', autoMerge: true}]), {});

    /* Then */
    assert.strictEqual(lands, true);
});

test('a pull request neither queued nor on auto-merge does not land on its own', () => {
    /* When */
    const lands = pullRequestsLand([pr(1)], status([{number: 1, dot: 'green'}]), {});

    /* Then */
    assert.strictEqual(lands, false);
});

test('a held entry does not land on its own', () => {
    /* When */
    const lands = pullRequestsLand([pr(1)], status([{number: 1, dot: 'green'}]), queue({1: 'held'}));

    /* Then */
    assert.strictEqual(lands, false);
});

test('a failing pull request does not land, queued or not', () => {
    /* When */
    const lands = pullRequestsLand([pr(1)], status([{number: 1, dot: 'red', autoMerge: true}]), queue({1: 'queued'}));

    /* Then */
    assert.strictEqual(lands, false);
});

test('a pull request that waits on the user does not land', () => {
    /* When */
    const lands = pullRequestsLand([pr(1)], status([{number: 1, dot: 'green', autoMerge: true}], true), {});

    /* Then */
    assert.strictEqual(lands, false);
});

test('merged and closed pull requests are passed over', () => {
    /* Given */
    const dots: PullRequestDot[] = [
        {number: 1, dot: 'merged'},
        {number: 2, dot: 'green', closed: true},
        {number: 3, dot: 'amber', autoMerge: true},
    ];

    /* When */
    const lands = pullRequestsLand([pr(1), pr(2), pr(3)], status(dots), {});

    /* Then */
    assert.strictEqual(lands, true);
});

test('a session with only merged pull requests has nothing landing', () => {
    /* When */
    const lands = pullRequestsLand([pr(1)], status([{number: 1, dot: 'merged'}]), {});

    /* Then */
    assert.strictEqual(lands, false);
});

test('a pull request the CI watch has said nothing about does not count as landing', () => {
    /* When */
    const lands = pullRequestsLand([pr(1)], undefined, queue({1: 'queued'}));

    /* Then */
    assert.strictEqual(lands, false);
});
