import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allMerged, offersMarkDone, openedPullRequestLine, type PullRequestState } from '../src/domain/tasks/writes';

const url = (n: number) => `https://github.com/o/app/pull/${n}`;
const states = (table: Record<number, PullRequestState>) => (u: string) => {
  const n = Number(u.split('/').pop());
  return table[n] ?? null;
};

test('every PR merged is all merged', () => {
  /* Given */
  const prs = [{ url: url(1) }, { url: url(2) }];

  /* When */
  const merged = allMerged(prs, states({ 1: 'merged', 2: 'merged' }));

  /* Then */
  assert.equal(merged, true);
});

test('one PR closed without merging, still open, a draft or never heard of is not all merged', () => {
  /* Given */
  const prs = [{ url: url(1) }, { url: url(2) }];

  /* When */
  const answers = (['closed', 'open', 'draft'] as const).map((state) => allMerged(prs, states({ 1: 'merged', 2: state })));
  const unknown = allMerged(prs, states({ 1: 'merged' }));

  /* Then */
  assert.deepEqual(answers, [false, false, false]);
  assert.equal(unknown, false);
});

test('a session that opened no PRs is not all merged', () => {
  /* Given */
  const prs: { url: string }[] = [];

  /* When */
  const merged = allMerged(prs, () => 'merged');

  /* Then */
  assert.equal(merged, false);
});

test('Mark done is offered only when you archived it and every PR is merged', () => {
  /* Given */
  const prs = [{ url: url(1) }];
  const allIn = states({ 1: 'merged' });

  /* When */
  const byUser = offersMarkDone({ byUser: true }, prs, allIn);
  const bySession = offersMarkDone({ byUser: false }, prs, allIn);
  const notMerged = offersMarkDone({ byUser: true }, prs, states({ 1: 'closed' }));

  /* Then */
  assert.equal(byUser, true);
  assert.equal(bySession, false);
  assert.equal(notMerged, false);
});

test('a PR\'s progress line names its number', () => {
  /* Given */
  const pr = { number: 42 };

  /* When */
  const line = openedPullRequestLine(pr);

  /* Then */
  assert.equal(line, 'Opened PR #42');
});
