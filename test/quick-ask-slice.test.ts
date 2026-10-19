/**
 * The Quick Ask pop-up (#142): the empty screen's box, the replies main gives,
 * the result shown on top of the box, and the draft kept between showings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canClose, initialQuickAskState, quickAskPhase, quickAskReducer } from '../src/renderer/state/quick-ask-slice';
import type { QuickAskEvent, QuickAskState } from '../src/renderer/state/quick-ask-slice';
import type { QuickAskReply } from '../src/ipc/quick-ask-api';

function run(state: QuickAskState, ...events: QuickAskEvent[]): QuickAskState {
  return events.reduce((s, e) => quickAskReducer(Object.freeze(s), e), state);
}

const TEXT = 'fix the flaky upload test';

const CHOOSE: QuickAskReply = {
  kind: 'choose',
  candidates: [
    { projectPath: '/dev/cityrow-ios', folder: 'cityrow-ios' },
    { projectPath: '/dev/waterrower-ios', folder: 'waterrower-ios' },
    { projectPath: '/dev/kmm', folder: 'kmm' },
  ],
};

function waiting(): QuickAskState {
  return run(initialQuickAskState, { type: 'askTextChanged', text: TEXT }, { type: 'askSent' });
}

function replied(reply: QuickAskReply, state = waiting()): QuickAskState {
  return run(state, { type: 'quickAskReplied', asked: state.box.asked, reply });
}

// ── Sending and the replies ──

test('Enter sends: the box waits with the text in it', () => {
  /* When */
  const state = waiting();

  /* Then */
  assert.equal(quickAskPhase(state), 'waiting');
  assert.equal(state.box.text, TEXT);
});

test('a started reply clears the draft and says where the session started', () => {
  /* When */
  const state = replied({ kind: 'started', folder: 'switchboard' });

  /* Then */
  assert.equal(quickAskPhase(state), 'started');
  assert.deepEqual(state.result, { kind: 'started', folder: 'switchboard' });
  assert.equal(state.box.text, '');
});

test('a choose reply lists the candidates, the first highlighted, each under its folder', () => {
  /* When */
  const state = replied(CHOOSE);

  /* Then */
  assert.equal(quickAskPhase(state), 'choosing');
  assert.deepEqual(state.box.choices, ['/dev/cityrow-ios', '/dev/waterrower-ios', '/dev/kmm']);
  assert.deepEqual(state.folders, ['cityrow-ios', 'waterrower-ios', 'kmm']);
  assert.equal(state.box.selected, 0);
});

test('a choose reply with no candidates goes back to editing', () => {
  /* When */
  const state = replied({ kind: 'choose', candidates: [] });

  /* Then */
  assert.equal(quickAskPhase(state), 'editing');
  assert.equal(state.box.text, TEXT);
});

test('a hand-off keeps the text, as the empty screen’s box does', () => {
  /* When */
  const state = replied({ kind: 'handedOff' });

  /* Then */
  assert.equal(quickAskPhase(state), 'editing');
  assert.equal(state.box.text, TEXT);
  assert.equal(state.box.handedOff, true);
});

test('a saved reply clears the draft and shows the summary', () => {
  /* When */
  const state = replied({ kind: 'saved', target: 'tasks', summary: 'Task added · Call Peter · due Thu' });

  /* Then */
  assert.equal(quickAskPhase(state), 'saved');
  assert.equal(state.box.text, '');
  assert.deepEqual(state.result, { kind: 'saved', target: 'tasks', summary: 'Task added · Call Peter · due Thu' });
});

test('a failed capture keeps the text and Patch’s line, until the text changes', () => {
  /* Given */
  const failed = replied({ kind: 'captureFailed', reason: 'BlaakTasks didn’t answer.' });

  /* When */
  const edited = run(failed, { type: 'askTextChanged', text: TEXT + '!' });

  /* Then */
  assert.equal(quickAskPhase(failed), 'editing');
  assert.equal(failed.box.text, TEXT);
  assert.equal(failed.note, 'BlaakTasks didn’t answer.');
  assert.equal(edited.note, '');
});

test('the answer to a send the user cancelled is dropped', () => {
  /* Given */
  const sent = waiting();
  const cancelled = run(sent, { type: 'askCancelled' });

  /* When */
  const state = run(cancelled, { type: 'quickAskReplied', asked: sent.box.asked, reply: { kind: 'started', folder: 'x' } });

  /* Then */
  assert.equal(state, cancelled);
  assert.equal(quickAskPhase(state), 'editing');
  assert.equal(state.box.text, TEXT);
});

// ── The choice list ──

test('Enter on a choice waits while main starts it, and its reply says where', () => {
  /* Given */
  const choosing = run(replied(CHOOSE), { type: 'askChoiceStepped', step: 1 });

  /* When */
  const sent = run(choosing, { type: 'quickAskChoiceSent' });
  const started = replied({ kind: 'started', folder: 'waterrower-ios' }, sent);

  /* Then */
  assert.equal(quickAskPhase(sent), 'waiting');
  assert.deepEqual(sent.box.choices, []);
  assert.equal(quickAskPhase(started), 'started');
  assert.equal(started.box.text, '');
});

test('Esc in the list closes it and keeps the text to edit', () => {
  /* When */
  const state = run(replied(CHOOSE), { type: 'askChoicesClosed' });

  /* Then */
  assert.equal(quickAskPhase(state), 'editing');
  assert.equal(state.box.text, TEXT);
  assert.deepEqual(state.folders, []);
});

// ── Saving ──

test('a send that turns out to be a capture shows as saving, and cannot be closed', () => {
  /* When */
  const state = run(waiting(), { type: 'quickAskSaving' });

  /* Then */
  assert.equal(quickAskPhase(state), 'saving');
  assert.equal(canClose(quickAskPhase(state)), false);
});

test('saving only follows a send', () => {
  /* When */
  const state = run(initialQuickAskState, { type: 'quickAskSaving' });

  /* Then */
  assert.equal(state, initialQuickAskState);
});

// ── Closing and showing again ──

test('it closes while editing, choosing or showing a result, never while waiting or saving', () => {
  /* When */
  const closes = (['editing', 'choosing', 'started', 'saved', 'waiting', 'saving'] as const).map(canClose);

  /* Then */
  assert.deepEqual(closes, [true, true, true, true, false, false]);
});

test('closing while choosing keeps the draft, and it comes back to edit', () => {
  /* When */
  const state = run(replied(CHOOSE), { type: 'quickAskClosed' }, { type: 'quickAskShown' });

  /* Then */
  assert.equal(quickAskPhase(state), 'editing');
  assert.equal(state.box.text, TEXT);
  assert.deepEqual(state.box.choices, []);
});

test('closing after a start puts the result away, so the next showing is a fresh box', () => {
  /* When */
  const state = run(replied({ kind: 'started', folder: 'switchboard' }), { type: 'quickAskClosed' });

  /* Then */
  assert.equal(quickAskPhase(state), 'editing');
  assert.equal(state.result, null);
  assert.equal(state.box.text, '');
});

test('a close while waiting changes nothing', () => {
  /* Given */
  const sent = waiting();

  /* When */
  const state = run(sent, { type: 'quickAskClosed' });

  /* Then */
  assert.equal(state, sent);
});

test('showing a box that was left editing changes nothing', () => {
  /* Given */
  const typed = run(initialQuickAskState, { type: 'askTextChanged', text: TEXT });

  /* When */
  const state = run(typed, { type: 'quickAskShown' });

  /* Then */
  assert.equal(state, typed);
});
