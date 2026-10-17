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

test('a line answers to its own anchor; a context line to its old number on the left too', () => {
  const [context, deleted, added] = file.hunks[0].lines;
  assert.deepEqual(lineAnchorKeys(context), ['RIGHT:10', 'LEFT:10']);
  assert.deepEqual(lineAnchorKeys(deleted), ['LEFT:11']);
  assert.deepEqual(lineAnchorKeys(added), ['RIGHT:11']);
});

test('threads go under their line; one whose line is gone, or on the file, is outdated', () => {
  const placed = placeOnFile(file, [
    thread('added', 11),
    thread('deleted', 11, 'LEFT'),
    thread('context-left', 12, 'LEFT'),
    thread('gone', 40),
    thread('file', null),
    thread('elsewhere', 11, 'RIGHT', 'src/b.ts'),
  ]);
  assert.deepEqual([...placed.byLine].map(([key, list]) => [key, list.map((t) => t.id)]), [
    ['RIGHT:11', ['added']],
    ['LEFT:11', ['deleted']],
    // Old line 12 is the context line `three`, new line 12: it goes under that row.
    ['RIGHT:12', ['context-left']],
  ]);
  assert.deepEqual(placed.outdated.map((t) => t.id), ['gone', 'file']);
});

test('a file review files threads, pending comments and the composer under their lines', () => {
  const pr: PullRequestStatus = {
    number: 1, url: 'u', repository: 'o/a', closes: [],
    threads: [thread('T1', 11), thread('T2', 99)],
    pendingReview: [{ path: 'src/a.ts', line: 11, side: 'LEFT', body: 'why?' }, { path: 'src/a.ts', line: 98, side: 'RIGHT', body: 'old' }],
  };
  const review = fileReview('item', file, pr, true, { itemId: 'item', path: 'src/a.ts', line: 13, side: 'RIGHT' })!;
  const [, deleted, added, , four] = file.hunks[0].lines;
  assert.deepEqual(review.notes.get(noteKey(added))!.threads.map((t) => t.id), ['T1']);
  assert.deepEqual(review.notes.get(noteKey(deleted))!.pending.map((c) => c.body), ['why?']);
  assert.equal(review.notes.get(noteKey(four))!.composer, true);
  assert.deepEqual(review.outdated.map((t) => t.id), ['T2']);
  assert.deepEqual(review.outdatedPending.map((c) => c.body), ['old']);
});

test('a plain diff with nothing on it and no comments to take has no review', () => {
  assert.equal(fileReview('item', file, null, false, null), null);
  assert.equal(fileReview('item', file, null, true, null)?.commentable, true);
  // The composer of another item is not this one's.
  const other = fileReview('item', file, null, true, { itemId: 'other', path: 'src/a.ts', line: 11, side: 'RIGHT' })!;
  assert.equal(other.notes.size, 0);
});

// ── Rules ──

const prItem = (state: PullRequestStatus['state']): SessionWorkItem => ({
  id: 'pr', kind: 'pr', pr: { number: 1, url: 'u', repository: 'o/a', state, closes: [] }, location: null,
  diff: { kind: 'pull-request', repository: 'o/a', number: 1 }, activity: null,
});

test('only an open PR with gh takes comments', () => {
  assert.equal(canComment(prItem('open'), 'ok'), true);
  assert.equal(canComment(prItem('draft'), 'ok'), true);
  assert.equal(canComment(prItem('merged'), 'ok'), false);
  assert.equal(canComment(prItem('open'), 'missing'), false);
});

test('fix submits as Request changes, submit as a comment', () => {
  assert.equal(submitEvent('fix'), 'REQUEST_CHANGES');
  assert.equal(submitEvent('submit'), 'COMMENT');
});

test('threads to fix: every open one, or just the named open ones', () => {
  const pr: PullRequestStatus = {
    number: 1, url: 'u', repository: 'o/a', closes: [],
    threads: [thread('A', 1), thread('B', 2, 'RIGHT', 'src/a.ts', true), thread('C', 3)],
  };
  assert.deepEqual(threadsToFix(pr).map((t) => t.id), ['A', 'C']);
  assert.deepEqual(threadsToFix(pr, ['B', 'C']).map((t) => t.id), ['C']);
});

test('a Fix comments prompt gives its thread ids back, whatever the bodies say', () => {
  const tricky = { ...thread('PRRT_x1', 4), comments: [{ author: 'sam', isBot: false, body: 'see (this)', createdAt: '' }] };
  const prompt = renderPrompt({ action: 'fix-comments', number: 1, url: 'u (x)', threads: [tricky, thread('PRRT_y2', null)], worktree: '/w' });
  assert.deepEqual(promptThreadIds(prompt), ['PRRT_x1', 'PRRT_y2']);
  assert.deepEqual(promptThreadIds('Ship PR #1 (u).'), []);
});

test('avatar initials', () => {
  assert.equal(initials('jane-doe'), 'JD');
  assert.equal(initials('octocat'), 'OC');
  assert.equal(initials('dependabot[bot]'), 'DE');
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

test('the composer opens on a line of the selected item, one at a time, and closes', () => {
  let state = run(open(), composerOn());
  assert.deepEqual(state.sessionWork.page!.composer, { itemId: 'pr:1', path: 'src/a.ts', line: 11, side: 'RIGHT' });
  state = run(state, composerOn(12));
  assert.equal(state.sessionWork.page!.composer!.line, 12);
  assert.equal(run(state, { type: 'sessionWorkComposerClosed' }).sessionWork.page!.composer, null);
  // Not on an item that is not selected; and selecting another closes it.
  assert.equal(run(open(), { ...composerOn(), itemId: 'pr:2' } as RendererEvent).sessionWork.page!.composer, null);
  assert.equal(run(state, { type: 'sessionWorkItemSelected', itemId: 'pr:2' }).sessionWork.page!.composer, null);
});

test('a comment that went in closes the composer; a refused one keeps it with the reason', () => {
  const asked = run(open(), composerOn(), { type: 'sessionWorkReviewRequested', sessionId: 's1', itemId: 'pr:1', kind: 'comment' });
  assert.deepEqual(asked.sessionWork.page!.reviewPending, { itemId: 'pr:1', kind: 'comment' });
  // A second write waits for the first.
  assert.equal(run(asked, { type: 'sessionWorkReviewRequested', sessionId: 's1', itemId: 'pr:1', kind: 'submit' }), asked);

  const refused = run(asked, { type: 'sessionWorkReviewAnswered', sessionId: 's1', itemId: 'pr:1', kind: 'comment', error: 'nope' });
  assert.equal(refused.sessionWork.page!.reviewPending, null);
  assert.deepEqual(refused.sessionWork.page!.reviewError, { itemId: 'pr:1', kind: 'comment', message: 'nope' });
  assert.notEqual(refused.sessionWork.page!.composer, null);

  const added = run(asked, { type: 'sessionWorkReviewAnswered', sessionId: 's1', itemId: 'pr:1', kind: 'comment', error: null });
  assert.equal(added.sessionWork.page!.composer, null);
  assert.equal(added.sessionWork.page!.reviewError, null);
});

test('one thread\'s Have Claude fix keeps its refusal on that thread', () => {
  const state = run(open(),
    { type: 'sessionWorkActionRequested', sessionId: 's1', itemId: 'pr:1', action: 'fix-comments', threadIds: ['T1'] },
    { type: 'sessionWorkActionAnswered', sessionId: 's1', itemId: 'pr:1', error: 'Already queued' });
  assert.deepEqual(state.sessionWork.page!.actionError, { itemId: 'pr:1', message: 'Already queued', threadIds: ['T1'] });
});
