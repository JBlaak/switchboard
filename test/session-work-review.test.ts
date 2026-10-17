import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUnifiedDiff } from '../src/domain/session-work/diff';
import { canComment, initials, lineAnchorKeys, placeOnFile, submitEvent, threadsToFix } from '../src/domain/session-work/review';
import { promptThreadIds, renderPrompt } from '../src/domain/session-work/prompts';
import { fileReview, noteKey } from '../src/renderer/ui/session-work/review-notes';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { PullRequestStatus, ReviewThread, SessionWorkItem, SessionWorkSnapshot } from '../src/domain/session-work/model';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,4 @@ export function a() {
 const one = 1;
-const two = 2;
+const two = 3;
 const three = 3;
 const four = 4;
`;

const [file] = parseUnifiedDiff(DIFF);

function thread(id: string, line: number | null, side: 'LEFT' | 'RIGHT' = 'RIGHT', path = 'src/a.ts', resolved = false): ReviewThread {
  return { id, path, line, side, resolved, comments: [{ author: 'sam', isBot: false, body: 'look at ' + id, createdAt: '' }] };
}

// ── Placement ──

test('a context line answers to its new number on the right and its old number on the left', () => {
  /* Given */
  const [context] = file.hunks[0].lines;

  /* When */
  const keys = lineAnchorKeys(context);

  /* Then */
  assert.deepEqual(keys, ['RIGHT:10', 'LEFT:10']);
});

test('a deleted line answers to its old number on the left', () => {
  /* Given */
  const [, deleted] = file.hunks[0].lines;

  /* When */
  const keys = lineAnchorKeys(deleted);

  /* Then */
  assert.deepEqual(keys, ['LEFT:11']);
});

test('an added line answers to its new number on the right', () => {
  /* Given */
  const [, , added] = file.hunks[0].lines;

  /* When */
  const keys = lineAnchorKeys(added);

  /* Then */
  assert.deepEqual(keys, ['RIGHT:11']);
});

test('threads go under their line; one whose line is gone, or on the file, is outdated', () => {
  /* Given */
  const threads = [
    thread('added', 11),
    thread('deleted', 11, 'LEFT'),
    thread('context-left', 12, 'LEFT'),
    thread('gone', 40),
    thread('file', null),
    thread('elsewhere', 11, 'RIGHT', 'src/b.ts'),
  ];

  /* When */
  const placed = placeOnFile(file, threads);

  /* Then */
  assert.deepEqual([...placed.byLine].map(([key, list]) => [key, list.map((t) => t.id)]), [
    ['RIGHT:11', ['added']],
    ['LEFT:11', ['deleted']],
    // Old line 12 is the context line `three`, new line 12: it goes under that row.
    ['RIGHT:12', ['context-left']],
  ]);
  assert.deepEqual(placed.outdated.map((t) => t.id), ['gone', 'file']);
});

test('a file review files threads, pending comments and the composer under their lines', () => {
  /* Given */
  const pr: PullRequestStatus = {
    number: 1, url: 'u', repository: 'o/a', closes: [],
    threads: [thread('T1', 11), thread('T2', 99)],
    pendingReview: [{ path: 'src/a.ts', line: 11, side: 'LEFT', body: 'why?' }, { path: 'src/a.ts', line: 98, side: 'RIGHT', body: 'old' }],
  };
  const [, deleted, added, , four] = file.hunks[0].lines;

  /* When */
  const review = fileReview('item', file, pr, true, { itemId: 'item', path: 'src/a.ts', line: 13, side: 'RIGHT' })!;

  /* Then */
  assert.deepEqual(review.notes.get(noteKey(added))!.threads.map((t) => t.id), ['T1']);
  assert.deepEqual(review.notes.get(noteKey(deleted))!.pending.map((c) => c.body), ['why?']);
  assert.equal(review.notes.get(noteKey(four))!.composer, true);
  assert.deepEqual(review.outdated.map((t) => t.id), ['T2']);
  assert.deepEqual(review.outdatedPending.map((c) => c.body), ['old']);
});

test('a plain diff with nothing on it and no comments to take has no review', () => {
  /* When */
  const review = fileReview('item', file, null, false, null);

  /* Then */
  assert.equal(review, null);
});

test('a plain diff that takes comments has a commentable review', () => {
  /* When */
  const review = fileReview('item', file, null, true, null);

  /* Then */
  assert.equal(review?.commentable, true);
});

test('the composer of another item is not this one\'s', () => {
  /* When */
  const other = fileReview('item', file, null, true, { itemId: 'other', path: 'src/a.ts', line: 11, side: 'RIGHT' })!;

  /* Then */
  assert.equal(other.notes.size, 0);
});

// ── Rules ──

const prItem = (state: PullRequestStatus['state']): SessionWorkItem => ({
  id: 'pr', kind: 'pr', pr: { number: 1, url: 'u', repository: 'o/a', state, closes: [] }, location: null,
  diff: { kind: 'pull-request', repository: 'o/a', number: 1 }, activity: null,
});

test('only an open PR with gh takes comments', () => {
  /* Given */
  const cases: [PullRequestStatus['state'], 'ok' | 'missing', boolean][] = [
    ['open', 'ok', true],
    ['draft', 'ok', true],
    ['merged', 'ok', false],
    ['open', 'missing', false],
  ];

  for (const [state, gh, expected] of cases) {
    /* When */
    const allowed = canComment(prItem(state), gh);

    /* Then */
    assert.equal(allowed, expected, `${state} with gh ${gh}`);
  }
});

test('fix submits as Request changes', () => {
  /* When */
  const event = submitEvent('fix');

  /* Then */
  assert.equal(event, 'REQUEST_CHANGES');
});

test('submit submits as a comment', () => {
  /* When */
  const event = submitEvent('submit');

  /* Then */
  assert.equal(event, 'COMMENT');
});

const threeThreads: PullRequestStatus = {
  number: 1, url: 'u', repository: 'o/a', closes: [],
  threads: [thread('A', 1), thread('B', 2, 'RIGHT', 'src/a.ts', true), thread('C', 3)],
};

test('threads to fix: every open one', () => {
  /* When */
  const threads = threadsToFix(threeThreads);

  /* Then */
  assert.deepEqual(threads.map((t) => t.id), ['A', 'C']);
});

test('threads to fix: just the named open ones', () => {
  /* When */
  const threads = threadsToFix(threeThreads, ['B', 'C']);

  /* Then */
  assert.deepEqual(threads.map((t) => t.id), ['C']);
});

test('a Fix comments prompt gives its thread ids back, whatever the bodies say', () => {
  /* Given */
  const tricky = { ...thread('PRRT_x1', 4), comments: [{ author: 'sam', isBot: false, body: 'see (this)', createdAt: '' }] };
  const prompt = renderPrompt({ action: 'fix-comments', number: 1, url: 'u (x)', threads: [tricky, thread('PRRT_y2', null)], worktree: '/w' });

  /* When */
  const ids = promptThreadIds(prompt);

  /* Then */
  assert.deepEqual(ids, ['PRRT_x1', 'PRRT_y2']);
});

test('a prompt that is not Fix comments gives no thread ids back', () => {
  /* When */
  const ids = promptThreadIds('Ship PR #1 (u).');

  /* Then */
  assert.deepEqual(ids, []);
});

test('avatar initials', () => {
  /* Given */
  const cases: [string, string][] = [
    ['jane-doe', 'JD'],
    ['octocat', 'OC'],
    ['dependabot[bot]', 'DE'],
  ];

  for (const [login, expected] of cases) {
    /* When */
    const letters = initials(login);

    /* Then */
    assert.equal(letters, expected);
  }
});

// ── Reducers ──

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const ITEM: SessionWorkItem = { ...prItem('open'), id: 'pr:1' };
const snapshot: SessionWorkSnapshot = {
  sessionId: 's1', repository: 'o/a', items: [ITEM, { ...ITEM, id: 'pr:2' }], footprint: { worktrees: 1, branches: 1 },
  queued: 0, gh: 'ok', updatedAt: '2026-10-17T12:00:00.000Z',
};
const open = (): RendererState => run(initialRendererState('s1'),
  { type: 'sessionWorkOpened', sessionId: 's1', name: 'x', at: 0 },
  { type: 'sessionWorkSnapshot', snapshot });
const composerOn = (line = 11): RendererEvent =>
  ({ type: 'sessionWorkComposerOpened', itemId: 'pr:1', path: 'src/a.ts', line, side: 'RIGHT' });

test('the composer opens on a line of the selected item', () => {
  /* Given */
  const state = open();

  /* When */
  const next = run(state, composerOn());

  /* Then */
  assert.deepEqual(next.sessionWork.page!.composer, { itemId: 'pr:1', path: 'src/a.ts', line: 11, side: 'RIGHT' });
});

test('the composer is open on one line at a time', () => {
  /* Given */
  const state = run(open(), composerOn());

  /* When */
  const next = run(state, composerOn(12));

  /* Then */
  assert.equal(next.sessionWork.page!.composer!.line, 12);
});

test('the composer closes', () => {
  /* Given */
  const state = run(open(), composerOn(), composerOn(12));

  /* When */
  const next = run(state, { type: 'sessionWorkComposerClosed' });

  /* Then */
  assert.equal(next.sessionWork.page!.composer, null);
});

test('the composer does not open on an item that is not selected', () => {
  /* Given */
  const state = open();

  /* When */
  const next = run(state, { ...composerOn(), itemId: 'pr:2' } as RendererEvent);

  /* Then */
  assert.equal(next.sessionWork.page!.composer, null);
});

test('selecting another item closes the composer', () => {
  /* Given */
  const state = run(open(), composerOn(), composerOn(12));

  /* When */
  const next = run(state, { type: 'sessionWorkItemSelected', itemId: 'pr:2' });

  /* Then */
  assert.equal(next.sessionWork.page!.composer, null);
});

const askedToComment = () => run(open(), composerOn(),
  { type: 'sessionWorkReviewRequested', sessionId: 's1', itemId: 'pr:1', kind: 'comment' });

test('asking to comment marks the review write pending', () => {
  /* Given */
  const state = run(open(), composerOn());

  /* When */
  const asked = run(state, { type: 'sessionWorkReviewRequested', sessionId: 's1', itemId: 'pr:1', kind: 'comment' });

  /* Then */
  assert.deepEqual(asked.sessionWork.page!.reviewPending, { itemId: 'pr:1', kind: 'comment' });
});

test('a second review write waits for the first', () => {
  /* Given */
  const asked = askedToComment();

  /* When */
  const next = run(asked, { type: 'sessionWorkReviewRequested', sessionId: 's1', itemId: 'pr:1', kind: 'submit' });

  /* Then */
  assert.equal(next, asked);
});

test('a refused comment keeps the composer with the reason', () => {
  /* Given */
  const asked = askedToComment();

  /* When */
  const refused = run(asked, { type: 'sessionWorkReviewAnswered', sessionId: 's1', itemId: 'pr:1', kind: 'comment', error: 'nope' });

  /* Then */
  assert.equal(refused.sessionWork.page!.reviewPending, null);
  assert.deepEqual(refused.sessionWork.page!.reviewError, { itemId: 'pr:1', kind: 'comment', message: 'nope' });
  assert.notEqual(refused.sessionWork.page!.composer, null);
});

test('a comment that went in closes the composer', () => {
  /* Given */
  const asked = askedToComment();

  /* When */
  const added = run(asked, { type: 'sessionWorkReviewAnswered', sessionId: 's1', itemId: 'pr:1', kind: 'comment', error: null });

  /* Then */
  assert.equal(added.sessionWork.page!.composer, null);
  assert.equal(added.sessionWork.page!.reviewError, null);
});

test('one thread\'s Have Claude fix keeps its refusal on that thread', () => {
  /* Given */
  const asked = run(open(),
    { type: 'sessionWorkActionRequested', sessionId: 's1', itemId: 'pr:1', action: 'fix-comments', threadIds: ['T1'] });

  /* When */
  const state = run(asked,
    { type: 'sessionWorkActionAnswered', sessionId: 's1', itemId: 'pr:1', error: 'Already queued' });

  /* Then */
  assert.deepEqual(state.sessionWork.page!.actionError, { itemId: 'pr:1', message: 'Already queued', threadIds: ['T1'] });
});
