import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    isAuthorsNote,
    pullRequestWait,
    unresolvedThreadCount,
    type PullRequestWaitFacts,
} from '../src/domain/project/pull-request-wait';

/** An open PR with passing checks, no review asked and nothing in its way: ready to merge. */
function facts(fields: Partial<PullRequestWaitFacts> = {}): PullRequestWaitFacts {
    return {
        state: 'open',
        closedToday: false,
        draft: false,
        checks: {state: 'passing', failing: 0},
        failedChecks: [],
        cancelledChecks: [],
        review: null,
        reviewRequestedFromYou: false,
        reviewRequestedFromOthers: false,
        unresolvedThreads: 0,
        mergeable: 'mergeable',
        behindBase: null,
        queue: null,
        sessionWorking: false,
        ...fields,
    };
}

const failing = {checks: {state: 'failing', failing: 1}, failedChecks: ['test']} as const;

// ── Groups ──

test('a PR with green checks and nothing open is ready to merge, with no open point', () => {
    /* When */
    const wait = pullRequestWait(facts({review: 'approved'}));

    /* Then */
    assert.deepEqual(wait, {group: 'ready-to-merge', openPoint: ''});
});

test('failing CI with no linked session working on it needs you, naming the failed checks', () => {
    /* When */
    const wait = pullRequestWait(facts({checks: {state: 'failing', failing: 2}, failedChecks: ['test', 'lint']}));

    /* Then */
    assert.deepEqual(wait, {group: 'needs-you', openPoint: 'CI failing: test, lint'});
});

test('failing CI that a linked session is working on waits on CI instead', () => {
    /* When */
    const wait = pullRequestWait(facts({...failing, sessionWorking: true}));

    /* Then */
    assert.deepEqual(wait, {group: 'waiting-on-ci', openPoint: 'CI failing: test (a session is on it)'});
});

test('failing CI whose checks GitHub did not name still says it fails', () => {
    /* When */
    const wait = pullRequestWait(facts({checks: {state: 'failing', failing: 1}, failedChecks: []}));

    /* Then */
    assert.equal(wait.openPoint, 'CI failing');
});

test('more than three failed checks are named up to three, and counted after', () => {
    /* When */
    const wait = pullRequestWait(
        facts({checks: {state: 'failing', failing: 5}, failedChecks: ['a', 'b', 'c', 'd', 'e']}),
    );

    /* Then */
    assert.equal(wait.openPoint, 'CI failing: a, b, c +2');
});

test('a review requested from you needs you', () => {
    /* When */
    const wait = pullRequestWait(facts({review: 'review_required', reviewRequestedFromYou: true}));

    /* Then */
    assert.deepEqual(wait, {group: 'needs-you', openPoint: 'waiting on your review'});
});

test('changes requested needs you', () => {
    /* When */
    const wait = pullRequestWait(facts({review: 'changes_requested'}));

    /* Then */
    assert.deepEqual(wait, {group: 'needs-you', openPoint: 'changes requested'});
});

test('a conflict needs you, even while a linked session works on it', () => {
    /* When */
    const wait = pullRequestWait(facts({mergeable: 'conflicting', sessionWorking: true}));

    /* Then */
    assert.deepEqual(wait, {group: 'needs-you', openPoint: 'conflict'});
});

test('a draft needs you: somebody has to mark it ready', () => {
    /* When */
    const wait = pullRequestWait(facts({draft: true}));

    /* Then */
    assert.deepEqual(wait, {group: 'needs-you', openPoint: 'draft'});
});

test('a PR the merge queue failed needs you when nothing else names why', () => {
    /* When */
    const wait = pullRequestWait(facts({queue: 'failed'}));

    /* Then */
    assert.deepEqual(wait, {group: 'needs-you', openPoint: 'merge queue failed'});
});

test('a PR the merge queue failed for failing CI says the CI, not the queue', () => {
    /* When */
    const wait = pullRequestWait(facts({...failing, queue: 'failed'}));

    /* Then */
    assert.deepEqual(wait, {group: 'needs-you', openPoint: 'CI failing: test'});
});

test('running CI waits on CI, before a review it also waits on', () => {
    /* When */
    const wait = pullRequestWait(facts({checks: {state: 'running', failing: 0}, review: 'review_required'}));

    /* Then */
    assert.deepEqual(wait, {group: 'waiting-on-ci', openPoint: 'CI running · waiting on review'});
});

test('a PR in the merge queue waits on CI', () => {
    /* When */
    const wait = pullRequestWait(facts({queue: 'queued', review: 'approved'}));

    /* Then */
    assert.deepEqual(wait, {group: 'waiting-on-ci', openPoint: ''});
});

test('in the merge queue, CI that was only cancelled is no failure', () => {
    /* Given */
    const cancelled = {
        checks: {state: 'failing', failing: 1},
        failedChecks: ['test'],
        cancelledChecks: ['test'],
    } as const;

    /* When */
    const queued = pullRequestWait(facts({...cancelled, queue: 'queued', review: 'approved'}));
    const outside = pullRequestWait(facts({...cancelled}));

    /* Then */
    assert.deepEqual(queued, {group: 'waiting-on-ci', openPoint: ''});
    assert.deepEqual(outside, {group: 'needs-you', openPoint: 'CI failing: test'});
});

test('a required review waits on review', () => {
    /* When */
    const wait = pullRequestWait(facts({review: 'review_required'}));

    /* Then */
    assert.deepEqual(wait, {group: 'waiting-on-review', openPoint: 'waiting on review'});
});

test('a review requested from someone else waits on review, even when GitHub requires none', () => {
    /* When */
    const wait = pullRequestWait(facts({reviewRequestedFromOthers: true}));

    /* Then */
    assert.deepEqual(wait, {group: 'waiting-on-review', openPoint: 'waiting on review'});
});

test('unresolved threads wait on review and are counted', () => {
    /* When */
    const one = pullRequestWait(facts({unresolvedThreads: 1, review: 'approved'}));
    const two = pullRequestWait(facts({unresolvedThreads: 2, review: 'review_required'}));

    /* Then */
    assert.deepEqual(one, {group: 'waiting-on-review', openPoint: '1 unresolved thread'});
    assert.deepEqual(two, {group: 'waiting-on-review', openPoint: '2 unresolved threads'});
});

test('behind its base names the base, and does not hold back an otherwise ready PR', () => {
    /* When */
    const wait = pullRequestWait(facts({behindBase: 'main'}));

    /* Then */
    assert.deepEqual(wait, {group: 'ready-to-merge', openPoint: 'behind main'});
});

test('a PR that needs you for several reasons names each', () => {
    /* When */
    const wait = pullRequestWait(
        facts({
            ...failing,
            review: 'changes_requested',
            mergeable: 'conflicting',
            unresolvedThreads: 2,
            behindBase: 'main',
        }),
    );

    /* Then */
    assert.deepEqual(wait, {
        group: 'needs-you',
        openPoint: 'CI failing: test · changes requested · conflict · 2 unresolved threads · behind main',
    });
});

test('a PR merged or closed today is in Merged or closed today; an older merged one is not', () => {
    /* When */
    const merged = pullRequestWait(facts({state: 'merged', closedToday: true}));
    const closed = pullRequestWait(facts({state: 'closed', closedToday: true, ...failing}));
    const earlier = pullRequestWait(facts({state: 'merged', closedToday: false}));

    /* Then */
    assert.deepEqual(merged, {group: 'merged-or-closed-today', openPoint: 'merged'});
    assert.deepEqual(closed, {group: 'merged-or-closed-today', openPoint: 'closed'});
    assert.deepEqual(earlier, {group: 'merged-earlier', openPoint: 'merged'});
});

// ── Author's notes ──

test('a comment opening with the author’s-note header is an author’s note, quoted or not, either apostrophe', () => {
    /* When */
    const notes = [
        "> 🤖 **Claude Code** · author's note explaining this change — not review feedback\n\nWhy.",
        '🤖 **Claude Code** · author’s note\n\nWhy.',
        ">🤖 **Claude Code** · author's note",
    ].map(isAuthorsNote);
    const others = [
        'Why is this here?',
        "Re: > 🤖 **Claude Code** · author's note",
        '🤖 **Claude Code** · review',
        '',
    ].map(isAuthorsNote);

    /* Then */
    assert.deepEqual(notes, [true, true, true]);
    assert.deepEqual(others, [false, false, false, false]);
});

test('an author’s note counts as unresolved only once someone replied in it', () => {
    /* Given */
    const note = "> 🤖 **Claude Code** · author's note\n\nWhy.";

    /* When */
    const count = unresolvedThreadCount([
        {resolved: false, comments: 1, firstComment: note},
        {resolved: false, comments: 2, firstComment: note},
        {resolved: false, comments: 1, firstComment: 'Please rename this.'},
        {resolved: true, comments: 3, firstComment: 'Fixed.'},
    ]);

    /* Then */
    assert.equal(count, 2);
});
