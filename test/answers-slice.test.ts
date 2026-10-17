import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { PendingQuestions, Question } from '../src/domain/questions/question';

/** Freeze a state all the way down, so a reducer that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(deepFreeze(s), e), state);
}

const QUESTIONS: Question[] = [
  { question: 'Scope?', header: 'Scope', multiSelect: false, options: [{ label: 'Site', description: '' }, { label: 'App', description: '' }] },
  { question: 'Checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Unit', description: '' }, { label: 'Lint', description: '' }] },
];

function asked(sessionId: string, toolUseId: string, questions = QUESTIONS): PendingQuestions {
  return { sessionId, toolUseId, questions, askedAt: 0, deadline: 600_000 };
}

const askedT1: RendererEvent = { type: 'questionsAsked', pending: asked('s1', 't1') };
const action = (a: Extract<RendererEvent, { type: 'answerAction' }>['action']): RendererEvent =>
  ({ type: 'answerAction', toolUseId: 't1', action: a });

const greetedT1: RendererEvent = { type: 'answersGreeted', toolUseId: 't1' };
const viewChosen = (view: 'terminal' | 'questions'): RendererEvent => ({ type: 'answerViewChosen', toolUseId: 't1', view });
const dozed = (minutesLeft: number): RendererEvent => ({ type: 'answersDozed', toolUseId: 't1', minutesLeft });

/** Both questions picked, so the next `next` asks to send. */
function readyToSend(): RendererState {
  return run(initialRendererState(), askedT1,
    action({ kind: 'press', row: 0 }), action({ kind: 'next' }), action({ kind: 'press', row: 1 }));
}

test('a set that arrives gets a fresh entry, ungreeted and on the questions', () => {
  /* When */
  const entry = run(initialRendererState(), askedT1).answers.byToolUse.t1;

  /* Then */
  assert.strictEqual(entry.view, 'questions');
  assert.strictEqual(entry.greeted, false);
  assert.strictEqual(entry.said, null);
  assert.deepStrictEqual(entry.draft.picks, [[], []]);
});

test('settling a set drops its entry', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const settled = run(state,
    { type: 'questionsSettled', settled: { sessionId: 's1', toolUseId: 't1', outcome: 'answered' } });

  /* Then */
  assert.deepStrictEqual(settled.answers.byToolUse, {});
});

test('replacing a set drops its entry', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const replaced = run(state, { type: 'questionsAsked', pending: asked('s1', 't2') });

  /* Then */
  assert.deepStrictEqual(Object.keys(replaced.answers.byToolUse), ['t2']);
});

test('a re-key keeps the entry, draft and all', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1, action({ kind: 'press', row: 1 }));

  /* When */
  const forked = run(state, { type: 'sessionForked', oldId: 's1', newId: 's2' });

  /* Then */
  assert.deepStrictEqual(forked.answers.byToolUse.t1.draft.picks[0], ['App']);
  assert.strictEqual(forked.questions.bySession.s2.toolUseId, 't1');
});

test('an action goes through the draft rules and leaves what it meant for Patch', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const pressed = run(state, action({ kind: 'press', row: 0 }));

  /* Then */
  const entry = pressed.answers.byToolUse.t1;
  assert.deepStrictEqual(entry.draft.picks[0], ['Site']);
  assert.deepStrictEqual(entry.said, { seq: 1, moment: { kind: 'picked', recommended: false } });
});

test('a quiet action changes the draft but not what Patch said', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const moved = run(state, action({ kind: 'move', by: 1 }));

  /* Then */
  assert.strictEqual(moved.answers.byToolUse.t1.draft.cursor, 1);
  assert.strictEqual(moved.answers.byToolUse.t1.said, null);
});

test('an action that changes nothing leaves the state as it was', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const next = rootReducer(state, action({ kind: 'back' }));

  /* Then */
  assert.strictEqual(next, state);
});

test('asking to send marks the set as sending', () => {
  /* Given */
  const ready = readyToSend();

  /* When */
  const sending = run(ready, action({ kind: 'next' }));

  /* Then */
  assert.strictEqual(sending.answers.byToolUse.t1.sending, true);
  // The send itself is not a line of Patch's.
  assert.strictEqual(sending.answers.byToolUse.t1.said, ready.answers.byToolUse.t1.said);
});

test('a set that is sending takes no input', () => {
  /* Given */
  const sending = run(readyToSend(), action({ kind: 'next' }));

  /* When */
  const next = rootReducer(sending, action({ kind: 'press', row: 0 }));

  /* Then */
  assert.strictEqual(next, sending);
});

test('greeting says hello', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const greeted = run(state, greetedT1);

  /* Then */
  assert.deepStrictEqual(greeted.answers.byToolUse.t1.said, { seq: 1, moment: { kind: 'arrived', count: 2 } });
});

test('greeting says hello only once', () => {
  /* Given */
  const greeted = run(initialRendererState(), askedT1, greetedT1);

  /* When */
  const again = rootReducer(greeted, greetedT1);

  /* Then */
  assert.strictEqual(again, greeted);
});

test('going to the terminal shows the terminal', () => {
  /* Given */
  const greeted = run(initialRendererState(), askedT1, greetedT1);

  /* When */
  const away = run(greeted, viewChosen('terminal'));

  /* Then */
  assert.strictEqual(away.answers.byToolUse.t1.view, 'terminal');
});

test('going to the terminal and back is a return', () => {
  /* Given */
  const away = run(initialRendererState(), askedT1, greetedT1, viewChosen('terminal'));

  /* When */
  const returned = run(away, viewChosen('questions'));

  /* Then */
  assert.deepStrictEqual(returned.answers.byToolUse.t1.said, { seq: 2, moment: { kind: 'returned' } });
});

test('pokes count up, and each is a new line', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const poked = run(state,
    { type: 'answersPatchPoked', toolUseId: 't1' }, { type: 'answersPatchPoked', toolUseId: 't1' });

  /* Then */
  assert.strictEqual(poked.answers.byToolUse.t1.pokes, 2);
  assert.deepStrictEqual(poked.answers.byToolUse.t1.said, { seq: 2, moment: { kind: 'poked', count: 2 } });
});

test('dozing says how many minutes are left', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const dozedOnce = run(state, dozed(3));

  /* Then */
  assert.deepStrictEqual(dozedOnce.answers.byToolUse.t1.said?.moment, { kind: 'waiting', minutesLeft: 3 });
});

test('dozing again with the same minutes left leaves the state as it was', () => {
  /* Given */
  const dozedOnce = run(initialRendererState(), askedT1, dozed(3));

  /* When */
  const again = rootReducer(dozedOnce, dozed(3));

  /* Then */
  assert.strictEqual(again, dozedOnce);
});

test('dozing with fewer minutes left records the new minute', () => {
  /* Given */
  const dozedOnce = run(initialRendererState(), askedT1, dozed(3));

  /* When */
  const later = run(dozedOnce, dozed(2));

  /* Then */
  assert.strictEqual(later.answers.byToolUse.t1.dozedAt, 2);
});

test('the prompt to deliver leaves the state as it was', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const next = rootReducer(state, { type: 'answersDelivered', toolUseId: 't1' });

  /* Then */
  assert.strictEqual(next, state);
});

test('the prompt to show the empty screen leaves the state as it was', () => {
  /* Given */
  const state = run(initialRendererState(), askedT1);

  /* When */
  const next = rootReducer(state, { type: 'emptyScreenShown' });

  /* Then */
  assert.strictEqual(next, state);
});
