import {test} from 'node:test';
import assert from 'node:assert/strict';

import {ReviewService, type ReviewPage} from '../src/application/services/review-service';
import {silentLog} from './support/fakes';
import type {GitHubCli, GitHubWrite, NewLineComment} from '../src/application/ports/github-cli';
import type {GitHubAvailability, PullRequestStatus, SessionWorkItem} from '../src/domain/session-work/model';
import type {ReviewEvent} from '../src/domain/session-work/review';

const URL = 'https://github.com/o/app/pull/12';
const ITEM = 'pr:' + URL;

function prItem(extra: Partial<PullRequestStatus> = {}): SessionWorkItem {
    return {
        id: ITEM,
        kind: 'pr',
        pr: {number: 12, url: URL, repository: 'o/app', state: 'open', nodeId: 'PR_12', closes: [], ...extra},
        location: null,
        diff: {kind: 'pull-request', repository: 'o/app', number: 12},
    };
}

type Write = {call: string; args: unknown[]};

/** GitHub as the test scripts it: every write recorded, each answered from `answers` or ok. */
function fakeGitHub(answers: Partial<Record<string, GitHubWrite<any>>> = {}) {
    const writes: Write[] = [];
    let reviews = 0;
    let threads = 0;
    const github: Pick<
        GitHubCli,
        'startPendingReview' | 'addPendingComment' | 'deletePendingReview' | 'submitPendingReview'
    > = {
        async startPendingReview(pullRequestId: string) {
            writes.push({call: 'start', args: [pullRequestId]});
            return answers.start ?? {ok: true, reviewId: 'PRR_' + ++reviews};
        },
        async addPendingComment(reviewId: string, comment: NewLineComment) {
            writes.push({call: 'add', args: [reviewId, comment]});
            return answers.add ?? {ok: true, threadId: 'PRRT_' + ++threads};
        },
        async deletePendingReview(reviewId: string) {
            writes.push({call: 'delete', args: [reviewId]});
            return answers.delete ?? {ok: true};
        },
        async submitPendingReview(reviewId: string, event: ReviewEvent) {
            writes.push({call: 'submit', args: [reviewId, event]});
            return answers.submit ?? {ok: true};
        },
    };
    return {github, writes};
}

function setup({
    item = prItem(),
    gh = 'ok' as GitHubAvailability,
    answers = {} as Partial<Record<string, GitHubWrite<any>>>,
} = {}) {
    const {github, writes} = fakeGitHub(answers);
    const state = {item, refreshes: 0};
    const page: ReviewPage = {
        item: (sessionId, itemId) => (sessionId === 's1' && itemId === state.item.id ? state.item : null),
        context: (sessionId) => (sessionId === 's1' ? {repository: 'o/app', gh} : null),
        async refreshGitHub() {
            state.refreshes++;
        },
    };
    const service = new ReviewService({github, page, log: silentLog});
    return {service, writes, state};
}

const comment = (body = 'Rename this', line = 3) => ({
    sessionId: 's1',
    itemId: ITEM,
    path: 'a.ts',
    line,
    side: 'RIGHT' as const,
    body,
});

test('the first comment starts a pending review on the PR, and the next goes into the same one', async () => {
    /* Given */
    const {service, writes, state} = setup();

    /* When */
    const first = await service.comment(comment());
    const second = await service.comment(comment('And this', 4));

    /* Then */
    assert.deepEqual(first, {ok: true});
    assert.deepEqual(second, {ok: true});
    assert.deepEqual(writes, [
        {call: 'start', args: ['PR_12']},
        {call: 'add', args: ['PRR_1', {path: 'a.ts', line: 3, side: 'RIGHT', body: 'Rename this'}]},
        {call: 'add', args: ['PRR_1', {path: 'a.ts', line: 4, side: 'RIGHT', body: 'And this'}]},
    ]);
    assert.equal(state.refreshes, 2, 'the page asks gh again after each write');
});

test('two comments at once still start one review: writes go one at a time', async () => {
    /* Given */
    const {service, writes} = setup();

    /* When */
    const both = await Promise.all([service.comment(comment('one')), service.comment(comment('two'))]);

    /* Then */
    assert.deepEqual(both, [{ok: true}, {ok: true}]);
    assert.deepEqual(
        writes.map((w) => w.call),
        ['start', 'add', 'add'],
    );
});

test('a pending review already on GitHub (say, from the browser) is the one commented into', async () => {
    /* Given */
    const {service, writes} = setup({item: prItem({pendingReviewId: 'PRR_browser'})});

    /* When */
    await service.comment(comment());

    /* Then */
    assert.deepEqual(
        writes.map((w) => [w.call, w.args[0]]),
        [['add', 'PRR_browser']],
    );
});

test('a blank comment, a bad line or a closed PR is refused without writing', async () => {
    /* Given */
    const cases = [
        [{}, comment('   ')],
        [{}, comment('x', 0)],
        [{item: prItem({state: 'merged'})}, comment()],
        [{gh: 'unauthenticated' as GitHubAvailability}, comment()],
        [{}, {...comment(), itemId: 'gone'}],
    ] as const;

    for (const [setupArgs, request] of cases) {
        const {service, writes} = setup(setupArgs);

        /* When */
        const result = await service.comment(request);

        /* Then */
        assert.equal(result.ok, false);
        assert.equal(writes.length, 0);
    }
});

test('a write GitHub refuses comes back with its reason', async () => {
    /* Given */
    const {service} = setup({answers: {add: {ok: false, reason: 'Line is not part of the diff'}}});

    /* When */
    const result = await service.comment(comment());

    /* Then */
    assert.deepEqual(result, {ok: false, reason: 'Could not add the comment: Line is not part of the diff'});
});

const pendingPr = prItem({
    pendingReviewId: 'PRR_9',
    pendingReview: [
        {path: 'a.ts', line: 3, side: 'RIGHT', body: 'one', threadId: 'PRRT_a'},
        {path: 'b.ts', line: 8, side: 'LEFT', body: 'two', threadId: 'PRRT_b'},
    ],
});

test('Submit submits the review as a comment', async () => {
    /* Given */
    const {service, writes, state} = setup({item: pendingPr});

    /* When */
    const result = await service.review({sessionId: 's1', itemId: ITEM, mode: 'submit'});

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(writes, [{call: 'submit', args: ['PRR_9', 'COMMENT']}]);
    assert.equal(state.refreshes, 1);
});

test('a submit GitHub refuses comes back with its reason', async () => {
    /* Given */
    const {service} = setup({
        item: pendingPr,
        answers: {submit: {ok: false, reason: 'Review is not pending'}},
    });

    /* When */
    const result = await service.review({sessionId: 's1', itemId: ITEM, mode: 'submit'});

    /* Then */
    assert.deepEqual(result, {ok: false, reason: 'Could not submit the review: Review is not pending'});
});

test('Discard deletes the pending review', async () => {
    /* Given */
    const {service, writes} = setup({item: pendingPr});

    /* When */
    const result = await service.review({sessionId: 's1', itemId: ITEM, mode: 'discard'});

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(writes, [{call: 'delete', args: ['PRR_9']}]);
});

test('with no review in progress there is nothing to submit or discard', async () => {
    /* Given */
    const {service, writes} = setup();

    for (const mode of ['submit', 'discard'] as const) {
        /* When */
        const result = await service.review({sessionId: 's1', itemId: ITEM, mode});

        /* Then */
        assert.deepEqual(result, {ok: false, reason: 'There is no review in progress'});
    }
    assert.equal(writes.length, 0);
});

test('after a discard, the next comment starts a new review', async () => {
    /* Given */
    const {service, writes, state} = setup();
    await service.comment(comment());
    state.item = prItem({pendingReview: [{path: 'a.ts', line: 3, side: 'RIGHT', body: 'x', threadId: 'PRRT_1'}]});
    await service.review({sessionId: 's1', itemId: ITEM, mode: 'discard'});
    state.item = prItem();

    /* When */
    await service.comment(comment());

    /* Then */
    assert.deepEqual(
        writes.map((w) => [w.call, w.args[0]]),
        [
            ['start', 'PR_12'],
            ['add', 'PRR_1'],
            ['delete', 'PRR_1'],
            ['start', 'PR_12'],
            ['add', 'PRR_2'],
        ],
    );
});
