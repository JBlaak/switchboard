import { test } from 'node:test';
import assert from 'node:assert';
import {
  addProposal, currentItem, emptyReview, isPending, isReviewComplete, isReviewEmpty,
  pendingProposals, progressLabel, rekeyReview, resolveProposal, reviewProgress, selectProposal,
  withdrawAll, withdrawProposal,
} from '../src/renderer/features/code/review-model';
import type { ProposedEdit, ReviewState } from '../src/renderer/features/code/review-model';

/**
 * The review's rules, exercised without a DOM.
 *
 * `review-model.ts` is deliberately the only part of the review with decisions
 * in it — `review-view.ts` builds merge views and sends the answers — and it
 * imports nothing that touches `document`, which is what lets this file import
 * it at all. The renderer has no jsdom harness and does not want one.
 *
 * This is the one surface in the app that can answer a process on the user's
 * behalf: every proposal here is a CLI call parked in the IDE bridge, waiting.
 * So the assertions worth having are the ones about *not* answering — a second
 * answer to one call, an "accept all" reaching an edit already rejected, an
 * arrival moving the file under a hand on its way to Accept.
 */

function edit(diffId: string, filePath = `/repo/src/${diffId}.ts`): ProposedEdit {
  return {
    diffId,
    filePath,
    tabName: `✻ [${diffId}]`,
    oldContent: 'before\n',
    newContent: 'after\n',
  };
}

/** A review of n files, none of them answered yet. */
function proposed(...ids: string[]): ReviewState {
  return ids.reduce((state, id) => addProposal(state, edit(id)), emptyReview('s1'));
}

/** The ids, in list order, of everything still parked. */
function waiting(state: ReviewState): string[] {
  return pendingProposals(state).map(item => item.edit.diffId);
}

// ── which file is current ─────────────────────────────────────────────────────

test('a review starts with nothing on screen', () => {
  const state = emptyReview('s1');
  assert.strictEqual(currentItem(state), null);
  assert.strictEqual(state.currentDiffId, null);
  assert.ok(isReviewEmpty(state));
  // Not "complete": nothing was ever asked, so nothing has been answered.
  assert.strictEqual(isReviewComplete(state), false);
});

test('the first proposal is the one on screen', () => {
  const state = proposed('a');
  assert.strictEqual(state.currentDiffId, 'a');
  assert.strictEqual(currentItem(state)?.edit.filePath, '/repo/src/a.ts');
});

test('a second proposal does not move the reader off the first', () => {
  // The whole point: an edit arriving while another is being read must not put
  // a different file under a hand already travelling towards Accept.
  const state = proposed('a', 'b', 'c');
  assert.strictEqual(state.currentDiffId, 'a');
  assert.deepStrictEqual(waiting(state), ['a', 'b', 'c']);
});

test('a proposal arriving after the last one was answered takes the screen', () => {
  // Nothing is being read, so there is nothing to interrupt.
  const answered = resolveProposal(proposed('a'), 'a', 'accept');
  const state = addProposal(answered, edit('b'));
  assert.strictEqual(state.currentDiffId, 'b');
});

test('the same diff id twice is one row, not two', () => {
  // The bridge mints an id per parked call, so a repeat is the same request
  // arriving again — two rows would offer two buttons for one waiting call.
  const first = proposed('a');
  const again = addProposal(first, { ...edit('a'), newContent: 'revised\n' });
  assert.strictEqual(again.items.length, 1);
  assert.strictEqual(again.items[0].edit.newContent, 'revised\n');
});

test('a file can be picked out of the list, and an unknown one is ignored', () => {
  const state = selectProposal(proposed('a', 'b'), 'b');
  assert.strictEqual(state.currentDiffId, 'b');
  assert.strictEqual(selectProposal(state, 'nope'), state);
});

// ── progress ──────────────────────────────────────────────────────────────────

test('progress counts what has been answered, of everything asked', () => {
  let state = proposed('a', 'b', 'c', 'd', 'e');
  assert.deepStrictEqual(reviewProgress(state), { reviewed: 0, total: 5 });
  assert.strictEqual(progressLabel(state), '5 files to review');

  state = resolveProposal(state, 'a', 'accept');
  state = resolveProposal(state, 'b', 'reject');
  assert.deepStrictEqual(reviewProgress(state), { reviewed: 2, total: 5 });
  assert.strictEqual(progressLabel(state), '2 of 5 reviewed');

  // A rejected file is reviewed too — the count is about answers given, not
  // about edits taken.
  assert.deepStrictEqual(waiting(state), ['c', 'd', 'e']);
});

test('one file is announced as one, not as a count of zero', () => {
  assert.strictEqual(progressLabel(proposed('a')), '1 file to review');
  assert.strictEqual(progressLabel(emptyReview('s1')), 'nothing to review');
});

// ── answering ─────────────────────────────────────────────────────────────────

test('answering moves to the next file still waiting', () => {
  const state = resolveProposal(proposed('a', 'b', 'c'), 'a', 'accept');
  assert.strictEqual(state.currentDiffId, 'b');
});

test('answering out of order comes back for what was skipped', () => {
  // The list can be clicked in any order, so "next" wraps rather than running
  // off the end and leaving a parked call with no way back to it.
  let state = selectProposal(proposed('a', 'b', 'c'), 'c');
  state = resolveProposal(state, 'c', 'accept');
  assert.strictEqual(state.currentDiffId, 'a');
});

test('an answered file cannot be answered again', () => {
  // The guard that makes a double click one answer. Two sends would resolve one
  // parked call twice, and the second would be an answer to nothing.
  const state = resolveProposal(proposed('a'), 'a', 'reject');
  assert.strictEqual(isPending(state, 'a'), false);
  assert.strictEqual(resolveProposal(state, 'a', 'accept'), state);
  assert.strictEqual(state.items[0].outcome, 'reject');
});

test('answering something that was never proposed changes nothing', () => {
  const state = proposed('a');
  assert.strictEqual(resolveProposal(state, 'ghost', 'accept'), state);
  assert.strictEqual(isPending(state, 'ghost'), false);
});

// ── accept all ────────────────────────────────────────────────────────────────

test('accept all reaches only what is still waiting', () => {
  // The file the user rejected one click ago keeps that answer: its call is
  // gone, and "all" must not read as a way to undo a decision the CLI has
  // already been told about.
  let state = proposed('a', 'b', 'c');
  state = resolveProposal(state, 'b', 'reject');

  assert.deepStrictEqual(waiting(state), ['a', 'c']);

  for (const item of pendingProposals(state)) {
    state = resolveProposal(state, item.edit.diffId, 'accept');
  }

  assert.deepStrictEqual(
    state.items.map(item => [item.edit.diffId, item.outcome]),
    [['a', 'accept'], ['b', 'reject'], ['c', 'accept']],
  );
});

test('accept all on a fully reviewed list is nothing to do', () => {
  const state = resolveProposal(proposed('a'), 'a', 'accept');
  assert.deepStrictEqual(waiting(state), []);
});

// ── the last file ─────────────────────────────────────────────────────────────

test('answering the last file completes the review without clearing it', () => {
  // Nothing is yanked off screen: the file the user just answered stays up,
  // marked, so they can see what they did. Only the CLI withdrawing an edit
  // takes a row off the list.
  let state = proposed('a', 'b');
  state = resolveProposal(state, 'a', 'accept');
  state = resolveProposal(state, 'b', 'reject');

  assert.ok(isReviewComplete(state));
  assert.strictEqual(isReviewEmpty(state), false);
  assert.deepStrictEqual(waiting(state), []);
  assert.strictEqual(state.currentDiffId, 'b');
  assert.strictEqual(progressLabel(state), '2 of 2 reviewed');
});

test('a completed review reopens when the session proposes again', () => {
  let state = resolveProposal(proposed('a'), 'a', 'accept');
  state = addProposal(state, edit('b'));

  assert.strictEqual(isReviewComplete(state), false);
  assert.strictEqual(state.currentDiffId, 'b');
  assert.deepStrictEqual(reviewProgress(state), { reviewed: 1, total: 2 });
});

// ── the CLI taking one back ───────────────────────────────────────────────────

test('a withdrawn file leaves the list, and the screen lands on one still waiting', () => {
  // close_tab is answered by the bridge on its way past, so this owes nothing
  // and sends nothing — it only drops a row.
  const state = withdrawProposal(proposed('a', 'b'), 'a');
  assert.deepStrictEqual(state.items.map(item => item.edit.diffId), ['b']);
  assert.strictEqual(state.currentDiffId, 'b');
});

test('withdrawing the last waiting file falls back to something to look at', () => {
  let state = proposed('a', 'b');
  state = resolveProposal(state, 'a', 'accept');   // current is now 'b'
  state = withdrawProposal(state, 'b');

  // 'a' is answered, but it is what is left, so the surface still has content
  // rather than a blank panel with rows behind it.
  assert.strictEqual(state.currentDiffId, 'a');
  assert.strictEqual(isReviewEmpty(state), false);
});

test('withdrawing a file nobody is looking at leaves the screen alone', () => {
  const state = withdrawProposal(proposed('a', 'b'), 'b');
  assert.strictEqual(state.currentDiffId, 'a');
});

test('withdrawing everything empties the review', () => {
  const state = withdrawAll(proposed('a', 'b'));
  assert.ok(isReviewEmpty(state));
  assert.strictEqual(state.currentDiffId, null);
  assert.strictEqual(state.sessionId, 's1');
});

// ── a fork under the review ───────────────────────────────────────────────────

test('a re-keyed session keeps its review, and the list is untouched', () => {
  // An answer addressed to the old id would find no parked call in the bridge,
  // which main re-keys at the same moment.
  const before = proposed('a', 'b');
  const after = rekeyReview(before, 's2');

  assert.strictEqual(after.sessionId, 's2');
  assert.deepStrictEqual(after.items, before.items);
  assert.strictEqual(after.currentDiffId, 'a');
});
