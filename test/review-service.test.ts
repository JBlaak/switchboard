import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReviewService, type FixRequester, type ReviewPage } from '../src/application/services/review-service';
import { silentLog } from './support/fakes';
import type { GitHubCli, GitHubWrite, NewLineComment } from '../src/application/ports/github-cli';
import type { ActionResult } from '../src/domain/session-work/actions';
import type { GitHubAvailability, PullRequestStatus, SessionWorkItem } from '../src/domain/session-work/model';
import type { ReviewEvent } from '../src/domain/session-work/review';

const URL = 'https://github.com/o/app/pull/12';
const ITEM = 'pr:' + URL;

function prItem(extra: Partial<PullRequestStatus> = {}): SessionWorkItem {
  return {
    id: ITEM,
    kind: 'pr',
    pr: { number: 12, url: URL, repository: 'o/app', state: 'open', nodeId: 'PR_12', closes: [], ...extra },
    location: null,
    diff: { kind: 'pull-request', repository: 'o/app', number: 12 },
    activity: null,
  };
}

type Write = { call: string; args: unknown[] };

/** GitHub as the test scripts it: every write recorded, each answered from `answers` or ok. */
function fakeGitHub(answers: Partial<Record<string, GitHubWrite<any>>> = {}) {
  const writes: Write[] = [];
  let reviews = 0;
  let threads = 0;
  const github: Pick<GitHubCli, 'startPendingReview' | 'addPendingComment' | 'deletePendingReview' | 'submitPendingReview'> = {
    async startPendingReview(pullRequestId: string) {
      writes.push({ call: 'start', args: [pullRequestId] });
      return answers.start ?? { ok: true, reviewId: 'PRR_' + ++reviews };
    },
    async addPendingComment(reviewId: string, comment: NewLineComment) {
      writes.push({ call: 'add', args: [reviewId, comment] });
      return answers.add ?? { ok: true, threadId: 'PRRT_' + ++threads };
    },
    async deletePendingReview(reviewId: string) {
      writes.push({ call: 'delete', args: [reviewId] });
      return answers.delete ?? { ok: true };
    },
    async submitPendingReview(reviewId: string, event: ReviewEvent) {
      writes.push({ call: 'submit', args: [reviewId, event] });
      return answers.submit ?? { ok: true };
    },
  };
  return { github, writes };
}

function setup({
  item = prItem(), gh = 'ok' as GitHubAvailability, answers = {} as Partial<Record<string, GitHubWrite<any>>>,
  fix = { ok: true, activityId: 'a1' } as ActionResult,
} = {}) {
  const { github, writes } = fakeGitHub(answers);
  const state = { item, refreshes: 0 };
  const page: ReviewPage = {
    item: (sessionId, itemId) => (sessionId === 's1' && itemId === state.item.id ? state.item : null),
    context: (sessionId) => (sessionId === 's1' ? { repository: 'o/app', mainCheckout: '/code/app', gh } : null),
    async refreshGitHub() { state.refreshes++; },
  };
  const requests: Array<{ itemId: string; action: string; threadIds?: readonly string[] }> = [];
  const actions: FixRequester = {
    async request(_sessionId, itemId, action, _origin, threadIds) {
      requests.push({ itemId, action, threadIds });
      return fix;
    },
  };
  const service = new ReviewService({ github, page, actions, log: silentLog });
  return { service, writes, state, requests };
}

const comment = (body = 'Rename this', line = 3) =>
  ({ sessionId: 's1', itemId: ITEM, path: 'a.ts', line, side: 'RIGHT' as const, body });

test('the first comment starts a pending review on the PR, and the next goes into the same one', async () => {
  const { service, writes, state } = setup();
  assert.deepEqual(await service.comment(comment()), { ok: true });
  assert.deepEqual(await service.comment(comment('And this', 4)), { ok: true });
  assert.deepEqual(writes, [
    { call: 'start', args: ['PR_12'] },
    { call: 'add', args: ['PRR_1', { path: 'a.ts', line: 3, side: 'RIGHT', body: 'Rename this' }] },
    { call: 'add', args: ['PRR_1', { path: 'a.ts', line: 4, side: 'RIGHT', body: 'And this' }] },
  ]);
  assert.equal(state.refreshes, 2, 'the page asks gh again after each write');
});

test('two comments at once still start one review: writes go one at a time', async () => {
  const { service, writes } = setup();
  const both = await Promise.all([service.comment(comment('one')), service.comment(comment('two'))]);
  assert.deepEqual(both, [{ ok: true }, { ok: true }]);
  assert.deepEqual(writes.map((w) => w.call), ['start', 'add', 'add']);
});

test('a pending review already on GitHub (say, from the browser) is the one commented into', async () => {
  const { service, writes } = setup({ item: prItem({ pendingReviewId: 'PRR_browser' }) });
  await service.comment(comment());
  assert.deepEqual(writes.map((w) => [w.call, w.args[0]]), [['add', 'PRR_browser']]);
});

test('a blank comment, a bad line or a closed PR is refused without writing', async () => {
  for (const [setupArgs, request] of [
    [{}, comment('   ')],
    [{}, comment('x', 0)],
    [{ item: prItem({ state: 'merged' }) }, comment()],
    [{ gh: 'unauthenticated' as GitHubAvailability }, comment()],
    [{}, { ...comment(), itemId: 'gone' }],
  ] as const) {
    const { service, writes } = setup(setupArgs);
    const result = await service.comment(request);
    assert.equal(result.ok, false);
    assert.equal(writes.length, 0);
  }
});

test('a write GitHub refuses comes back with its reason', async () => {
  const { service } = setup({ answers: { add: { ok: false, reason: 'Line is not part of the diff' } } });
  assert.deepEqual(await service.comment(comment()), { ok: false, reason: 'Could not add the comment: Line is not part of the diff' });
});

const pendingPr = prItem({
  pendingReviewId: 'PRR_9',
  pendingReview: [
    { path: 'a.ts', line: 3, side: 'RIGHT', body: 'one', threadId: 'PRRT_a' },
    { path: 'b.ts', line: 8, side: 'LEFT', body: 'two', threadId: 'PRRT_b' },
  ],
});

test('Submit only submits the review as a comment and hands nothing to Claude', async () => {
  const { service, writes, requests, state } = setup({ item: pendingPr });
  assert.deepEqual(await service.review({ sessionId: 's1', itemId: ITEM, mode: 'submit' }), { ok: true });
  assert.deepEqual(writes, [{ call: 'submit', args: ['PRR_9', 'COMMENT'] }]);
  assert.equal(requests.length, 0);
  assert.equal(state.refreshes, 1);
});

test('Submit & have Claude fix requests changes, then hands over exactly the submitted threads', async () => {
  const { service, writes, requests } = setup({ item: pendingPr });
  assert.deepEqual(await service.review({ sessionId: 's1', itemId: ITEM, mode: 'fix' }), { ok: true });
  assert.deepEqual(writes, [{ call: 'submit', args: ['PRR_9', 'REQUEST_CHANGES'] }]);
  assert.deepEqual(requests, [{ itemId: ITEM, action: 'fix-comments', threadIds: ['PRRT_a', 'PRRT_b'] }]);
});

test('a submitted review whose fix cannot be queued says so', async () => {
  const { service } = setup({ item: pendingPr, fix: { ok: false, reason: 'Start the session to hand this to Claude' } });
  assert.deepEqual(await service.review({ sessionId: 's1', itemId: ITEM, mode: 'fix' }),
    { ok: false, reason: 'Review submitted, but start the session to hand this to Claude' });
});

test('a submit GitHub refuses hands nothing to Claude', async () => {
  const { service, requests } = setup({ item: pendingPr, answers: { submit: { ok: false, reason: 'Review is not pending' } } });
  assert.deepEqual(await service.review({ sessionId: 's1', itemId: ITEM, mode: 'fix' }),
    { ok: false, reason: 'Could not submit the review: Review is not pending' });
  assert.equal(requests.length, 0);
});

test('Discard deletes the pending review', async () => {
  const { service, writes } = setup({ item: pendingPr });
  assert.deepEqual(await service.review({ sessionId: 's1', itemId: ITEM, mode: 'discard' }), { ok: true });
  assert.deepEqual(writes, [{ call: 'delete', args: ['PRR_9'] }]);
});

test('with no review in progress there is nothing to submit or discard', async () => {
  const { service, writes } = setup();
  for (const mode of ['fix', 'submit', 'discard'] as const) {
    assert.deepEqual(await service.review({ sessionId: 's1', itemId: ITEM, mode }), { ok: false, reason: 'There is no review in progress' });
  }
  assert.equal(writes.length, 0);
});

test('after a discard, the next comment starts a new review', async () => {
  const { service, writes, state } = setup();
  await service.comment(comment());
  state.item = prItem({ pendingReview: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'x', threadId: 'PRRT_1' }] });
  await service.review({ sessionId: 's1', itemId: ITEM, mode: 'discard' });
  state.item = prItem();
  await service.comment(comment());
  assert.deepEqual(writes.map((w) => [w.call, w.args[0]]), [
    ['start', 'PR_12'], ['add', 'PRR_1'], ['delete', 'PRR_1'], ['start', 'PR_12'], ['add', 'PRR_2'],
  ]);
});
