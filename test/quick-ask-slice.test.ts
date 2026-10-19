/**
 * The Quick Ask pop-up (#142): the empty screen's box, the replies main gives,
 * the result shown on top of the box, and the draft kept between showings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canClose, initialQuickAskState, quickAskPhase, quickAskReducer, savedLabel, savingLine,
} from '../src/renderer/state/quick-ask-slice';
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

test('a saved reply clears the draft and shows the summary, holding the text for ⌘Z', () => {
  /* When */
  const state = replied({ kind: 'saved', target: 'tasks', summary: 'Call Peter · due Thu' });

  /* Then */
  assert.equal(quickAskPhase(state), 'saved');
  assert.equal(state.box.text, '');
  assert.deepEqual(state.result, { kind: 'saved', target: 'tasks', summary: 'Call Peter · due Thu', text: TEXT });
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
  const state = run(waiting(), { type: 'quickAskSaving', target: 'james' });

  /* Then */
  assert.equal(quickAskPhase(state), 'saving');
  assert.deepEqual(state.result, { kind: 'saving', target: 'james' });
  assert.equal(canClose(quickAskPhase(state)), false);
});

test('saving says where it goes', () => {
  /* When */
  const lines = [savingLine('tasks'), savingLine('james'), savedLabel('tasks'), savedLabel('james')];

  /* Then */
  assert.deepEqual(lines, ['Adding to BlaakTasks…', 'Giving it to James…', 'Task added', 'Kept']);
});

test('saving only follows a send', () => {
  /* When */
  const state = run(initialQuickAskState, { type: 'quickAskSaving', target: 'tasks' });

  /* Then */
  assert.equal(state, initialQuickAskState);
});

// ── Closing and showing again ──

test('a failed retry after saving keeps the text again, for the next Enter', () => {
  /* Given */
  const saving = run(waiting(), { type: 'quickAskSaving', target: 'james' });

  /* When */
  const state = replied({ kind: 'captureFailed', reason: 'James didn’t answer. Try again?' }, saving);

  /* Then */
  assert.equal(quickAskPhase(state), 'editing');
  assert.equal(state.box.text, TEXT);
  assert.equal(state.note, 'James didn’t answer. Try again?');
});

// ── Undo ──

function saved(): QuickAskState {
  const saving = run(waiting(), { type: 'quickAskSaving', target: 'tasks' });
  return replied({ kind: 'saved', target: 'tasks', summary: 'Call Peter · due Thu' }, saving);
}

test('⌘Z on the saved line takes it back, and it cannot be closed meanwhile', () => {
  /* When */
  const state = run(saved(), { type: 'quickAskUndoing' });

  /* Then */
  assert.equal(quickAskPhase(state), 'undoing');
  assert.equal(canClose(quickAskPhase(state)), false);
});

test('undone shows "Undone", then the text is back in the box to edit', () => {
  /* Given */
  const undoing = run(saved(), { type: 'quickAskUndoing' });

  /* When */
  const undone = run(undoing, { type: 'quickAskUndone', ok: true });

  /* Then */
  assert.equal(quickAskPhase(undone), 'undone');

  /* When */
  const restored = run(undone, { type: 'quickAskRestored' });

  /* Then */
  assert.equal(quickAskPhase(restored), 'editing');
  assert.equal(restored.box.text, TEXT);
  assert.equal(restored.result, null);
});

test('closed while "Undone" shows, the text is back all the same', () => {
  /* Given */
  const undone = run(saved(), { type: 'quickAskUndoing' }, { type: 'quickAskUndone', ok: true });

  /* When */
  const state = run(undone, { type: 'quickAskClosed' });

  /* Then */
  assert.equal(state.box.text, TEXT);
  assert.equal(state.result, null);
});

test('an undo that failed says it is still there, and the draft stays clear', () => {
  /* Given */
  const undoing = run(saved(), { type: 'quickAskUndoing' });

  /* When */
  const state = run(undoing, { type: 'quickAskUndone', ok: false });

  /* Then */
  assert.equal(quickAskPhase(state), 'editing');
  assert.equal(state.box.text, '');
  assert.equal(state.note, 'Couldn’t take it back. It’s still in BlaakTasks.');
});

test('⌘Z means nothing without a saved line', () => {
  /* Given */
  const started = replied({ kind: 'started', folder: 'switchboard' });

  /* When */
  const state = run(started, { type: 'quickAskUndoing' }, { type: 'quickAskUndone', ok: true }, { type: 'quickAskRestored' });

  /* Then */
  assert.equal(state, started);
});

test('it closes while editing, choosing or showing a result, never while waiting, saving or undoing', () => {
  /* When */
  const closes = (['editing', 'choosing', 'started', 'saved', 'undone', 'waiting', 'saving', 'undoing'] as const)
    .map(canClose);

  /* Then */
  assert.deepEqual(closes, [true, true, true, true, true, false, false, false]);
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
