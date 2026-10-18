/**
 * The box on the empty screen (#135): typing, sending, waiting, the answer
 * and what it leads to, the choice list, and the hand-off to the picker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { askOutcome, canSend } from '../src/renderer/state/ask-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { RouteResult } from '../src/domain/ask/model';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const TEXT = 'Let’s fix the login in RP3 Web';
const PROMPT = 'Fix the login.\n\n(Original: "Let’s fix the login in RP3 Web")';

function typed(text = TEXT): RendererState {
  return run(initialRendererState(), { type: 'askTextChanged', text });
}

function waiting(): RendererState {
  return run(typed(), { type: 'askSent' });
}

function answered(result: RouteResult): RendererState {
  const state = waiting();
  return run(state, { type: 'askAnswered', asked: state.ask.asked, result });
}

const UNSURE: RouteResult = { kind: 'unsure', candidates: ['/dev/rp3-web', '/dev/rp3-api', '/dev/rp3'], prompt: PROMPT };

function choosing(): RendererState {
  return answered(UNSURE);
}

// ── Typing and sending ──

test('the box starts empty, ready to type in', () => {
  /* When */
  const { ask } = initialRendererState();

  /* Then */
  assert.equal(ask.phase, 'editing');
  assert.equal(ask.text, '');
});

test('typing puts the text in the box exactly as typed', () => {
  /* When */
  const state = typed('  two\nlines ');

  /* Then */
  assert.equal(state.ask.text, '  two\nlines ');
});

test('Enter sends: the box locks with the text still in it', () => {
  /* When */
  const state = waiting();

  /* Then */
  assert.equal(state.ask.phase, 'waiting');
  assert.equal(state.ask.text, TEXT);
  assert.equal(state.ask.asked, 1);
});

for (const [what, text] of [['an empty box', ''], ['a box of whitespace', ' \n\t ']] as const) {
  test(`Enter on ${what} sends nothing`, () => {
    /* Given */
    const state = typed(text);

    /* When */
    const sent = run(state, { type: 'askSent' });

    /* Then */
    assert.equal(sent, state);
    assert.equal(canSend(text), false);
  });
}

test('typing while waiting changes nothing: the box is locked', () => {
  /* Given */
  const state = waiting();

  /* When */
  const after = run(state, { type: 'askTextChanged', text: 'something else' });

  /* Then */
  assert.equal(after, state);
});

test('Enter while waiting does not send again', () => {
  /* Given */
  const state = waiting();

  /* When */
  const after = run(state, { type: 'askSent' });

  /* Then */
  assert.equal(after, state);
});

// ── Cancelling (W2) ──

test('Esc while waiting unlocks the box for editing, keeping the text', () => {
  /* When */
  const state = run(waiting(), { type: 'askCancelled' });

  /* Then */
  assert.equal(state.ask.phase, 'editing');
  assert.equal(state.ask.text, TEXT);
});

test('the answer to a cancelled send is dropped', () => {
  /* Given */
  const state = run(waiting(), { type: 'askCancelled' });

  /* When */
  const after = run(state, { type: 'askAnswered', asked: 1, result: { kind: 'cancelled' } });

  /* Then */
  assert.equal(after, state);
});

test('a late answer to a cancelled send does not settle the send after it', () => {
  /* Given: sent, cancelled, and sent again */
  const state = run(waiting(), { type: 'askCancelled' }, { type: 'askSent' });

  /* When */
  const after = run(state, {
    type: 'askAnswered', asked: 1, result: { kind: 'confident', projectPath: '/dev/a', prompt: 'p' },
  });

  /* Then */
  assert.equal(after.ask.phase, 'waiting');
  assert.equal(after.ask.asked, 2);
});

test('a cancelled answer to the send in flight just unlocks the box', () => {
  /* When */
  const state = answered({ kind: 'cancelled' });

  /* Then */
  assert.equal(state.ask.phase, 'editing');
  assert.equal(state.ask.text, TEXT);
});

// ── The answers (O1–O3) ──

test('a sure answer clears the box', () => {
  /* When */
  const state = answered({ kind: 'confident', projectPath: '/dev/rp3-web', prompt: PROMPT });

  /* Then */
  assert.equal(state.ask.phase, 'editing');
  assert.equal(state.ask.text, '');
});

test('an unsure answer lists the candidates, the best one highlighted, with the rewritten prompt', () => {
  /* When */
  const state = choosing();

  /* Then */
  assert.equal(state.ask.phase, 'choosing');
  assert.deepEqual(state.ask.choices, ['/dev/rp3-web', '/dev/rp3-api', '/dev/rp3']);
  assert.equal(state.ask.selected, 0);
  assert.equal(state.ask.prompt, PROMPT);
  assert.equal(state.ask.text, TEXT);
});

for (const result of [
  { kind: 'noMatch', reason: 'I don’t know that project.' },
  { kind: 'failed', reason: 'You hit your usage limit.' },
] as const) {
  test(`a ${result.kind} answer unlocks the box, keeping the text for the picker`, () => {
    /* When */
    const state = answered(result);

    /* Then */
    assert.equal(state.ask.phase, 'editing');
    assert.equal(state.ask.text, TEXT);
    assert.equal(state.ask.handedOff, true);
  });
}

// ── What an answer comes to ──

test('a sure answer starts the project on the prompt as it came', () => {
  /* When */
  const outcome = askOutcome({ kind: 'confident', projectPath: '/dev/a', prompt: PROMPT }, TEXT);

  /* Then */
  assert.deepEqual(outcome, { kind: 'start', projectPath: '/dev/a', prompt: PROMPT });
});

test('an unsure answer offers at most three candidates, each once, best first', () => {
  /* When */
  const outcome = askOutcome({ kind: 'unsure', candidates: ['/a', '/b', '/a', '/c', '/d'], prompt: PROMPT }, TEXT);

  /* Then */
  assert.deepEqual(outcome, { kind: 'choose', choices: ['/a', '/b', '/c'], prompt: PROMPT });
});

test('an unsure answer with no candidates opens the picker on the rewritten prompt', () => {
  /* When */
  const outcome = askOutcome({ kind: 'unsure', candidates: [], prompt: PROMPT }, TEXT);

  /* Then */
  assert.equal(outcome.kind, 'picker');
  assert.equal(outcome.kind === 'picker' && outcome.prompt, PROMPT);
});

test('no match opens the picker on the text exactly as typed, with Patch saying why (P3)', () => {
  /* When */
  const outcome = askOutcome({ kind: 'noMatch', reason: 'No project like that.' }, '  fix it\n');

  /* Then */
  assert.deepEqual(outcome, { kind: 'picker', prompt: '  fix it\n', say: 'No project like that.' });
});

test('a failed call opens the picker the same way', () => {
  /* When */
  const outcome = askOutcome({ kind: 'failed', reason: 'Claude timed out.' }, TEXT);

  /* Then */
  assert.deepEqual(outcome, { kind: 'picker', prompt: TEXT, say: 'Claude timed out.' });
});

test('a cancel only unlocks', () => {
  /* When */
  const outcome = askOutcome({ kind: 'cancelled' }, TEXT);

  /* Then */
  assert.deepEqual(outcome, { kind: 'unlock' });
});

// ── The choice list (O2) ──

test('↓ moves the highlight to the next choice', () => {
  /* When */
  const state = run(choosing(), { type: 'askChoiceStepped', step: 1 });

  /* Then */
  assert.equal(state.ask.selected, 1);
});

test('↑ from the first choice wraps to the last', () => {
  /* When */
  const state = run(choosing(), { type: 'askChoiceStepped', step: -1 });

  /* Then */
  assert.equal(state.ask.selected, 2);
});

test('the pointer over a choice highlights it', () => {
  /* When */
  const state = run(choosing(), { type: 'askChoiceHovered', index: 2 });

  /* Then */
  assert.equal(state.ask.selected, 2);
});

test('a hover outside the list changes nothing', () => {
  /* Given */
  const state = choosing();

  /* When */
  const after = run(state, { type: 'askChoiceHovered', index: 3 });

  /* Then */
  assert.equal(after, state);
});

test('starting a choice closes the list and clears the box', () => {
  /* When */
  const state = run(choosing(), { type: 'askChoiceStarted' });

  /* Then */
  assert.equal(state.ask.phase, 'editing');
  assert.equal(state.ask.text, '');
  assert.deepEqual(state.ask.choices, []);
});

test('Esc closes the list and goes back to editing the text', () => {
  /* When */
  const state = run(choosing(), { type: 'askChoicesClosed' });

  /* Then */
  assert.equal(state.ask.phase, 'editing');
  assert.equal(state.ask.text, TEXT);
  assert.deepEqual(state.ask.choices, []);
  assert.equal(state.ask.handedOff, false);
});

test('Tab closes the list and hands the text to the picker', () => {
  /* When */
  const state = run(choosing(), { type: 'askChoicesHandedOff' });

  /* Then */
  assert.equal(state.ask.phase, 'editing');
  assert.equal(state.ask.text, TEXT);
  assert.equal(state.ask.handedOff, true);
});

test('typing while choosing changes nothing: the box is locked', () => {
  /* Given */
  const state = choosing();

  /* When */
  const after = run(state, { type: 'askTextChanged', text: 'x' });

  /* Then */
  assert.equal(after, state);
});

// ── The picker carrying the text ──

test('a session started from the picker clears the box that handed it the text', () => {
  /* Given */
  const state = answered({ kind: 'noMatch', reason: 'No idea.' });

  /* When */
  const after = run(state, { type: 'pickerPromptLaunched' });

  /* Then */
  assert.equal(after.ask.text, '');
  assert.equal(after.ask.handedOff, false);
});

test('a dismissed picker leaves the text in the box', () => {
  /* Given */
  const state = run(answered({ kind: 'noMatch', reason: 'No idea.' }), {
    type: 'dialogOpened', request: { kind: 'projectPicker', initialPrompt: TEXT },
  });

  /* When */
  const after = run(state, { type: 'dialogClosed', seq: state.dialog.seq });

  /* Then */
  assert.equal(after.ask.text, TEXT);
});

test('text edited after a hand-off is the box’s own again: a later picker launch leaves it', () => {
  /* Given */
  const state = run(answered({ kind: 'noMatch', reason: 'No idea.' }), { type: 'askTextChanged', text: 'new idea' });

  /* When */
  const after = run(state, { type: 'pickerPromptLaunched' });

  /* Then */
  assert.equal(after.ask.text, 'new idea');
});

test('the picker remembers the prompt it was opened carrying', () => {
  /* When */
  const state = run(initialRendererState(), {
    type: 'dialogOpened', request: { kind: 'projectPicker', initialPrompt: TEXT },
  });

  /* Then */
  assert.deepEqual(state.dialog.open, { kind: 'projectPicker', initialPrompt: TEXT });
});
