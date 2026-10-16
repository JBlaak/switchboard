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

test('a set that arrives gets a fresh entry, ungreeted and on the questions', () => {
  const entry = run(initialRendererState(), askedT1).answers.byToolUse.t1;
  assert.strictEqual(entry.view, 'questions');
  assert.strictEqual(entry.greeted, false);
  assert.strictEqual(entry.said, null);
  assert.deepStrictEqual(entry.draft.picks, [[], []]);
});

test('settling or replacing a set drops its entry', () => {
  const settled = run(initialRendererState(), askedT1,
    { type: 'questionsSettled', settled: { sessionId: 's1', toolUseId: 't1', outcome: 'answered' } });
  assert.deepStrictEqual(settled.answers.byToolUse, {});
  const replaced = run(initialRendererState(), askedT1, { type: 'questionsAsked', pending: asked('s1', 't2') });
  assert.deepStrictEqual(Object.keys(replaced.answers.byToolUse), ['t2']);
});

test('a re-key keeps the entry, draft and all', () => {
  const state = run(initialRendererState(), askedT1, action({ kind: 'press', row: 1 }),
    { type: 'sessionForked', oldId: 's1', newId: 's2' });
  assert.deepStrictEqual(state.answers.byToolUse.t1.draft.picks[0], ['App']);
  assert.strictEqual(state.questions.bySession.s2.toolUseId, 't1');
});

test('an action goes through the draft rules and leaves what it meant for Patch', () => {
  const state = run(initialRendererState(), askedT1, action({ kind: 'press', row: 0 }));
  const entry = state.answers.byToolUse.t1;
  assert.deepStrictEqual(entry.draft.picks[0], ['Site']);
  assert.deepStrictEqual(entry.said, { seq: 1, moment: { kind: 'picked', recommended: false } });
});

test('a quiet action changes the draft but not what Patch said', () => {
  const state = run(initialRendererState(), askedT1, action({ kind: 'move', by: 1 }));
  assert.strictEqual(state.answers.byToolUse.t1.draft.cursor, 1);
  assert.strictEqual(state.answers.byToolUse.t1.said, null);
});

test('an action that changes nothing leaves the state as it was', () => {
  const state = run(initialRendererState(), askedT1);
  assert.strictEqual(rootReducer(state, action({ kind: 'back' })), state);
});

test('asking to send marks the set as sending, after which it takes no input', () => {
  const ready = run(initialRendererState(), askedT1,
    action({ kind: 'press', row: 0 }), action({ kind: 'next' }), action({ kind: 'press', row: 1 }));
  const sending = run(ready, action({ kind: 'next' }));
  assert.strictEqual(sending.answers.byToolUse.t1.sending, true);
  // The send itself is not a line of Patch's.
  assert.strictEqual(sending.answers.byToolUse.t1.said, ready.answers.byToolUse.t1.said);
  assert.strictEqual(rootReducer(sending, action({ kind: 'press', row: 0 })), sending);
});

test('greeting says hello once', () => {
  const greeted = run(initialRendererState(), askedT1, { type: 'answersGreeted', toolUseId: 't1' });
  assert.deepStrictEqual(greeted.answers.byToolUse.t1.said, { seq: 1, moment: { kind: 'arrived', count: 2 } });
  assert.strictEqual(rootReducer(greeted, { type: 'answersGreeted', toolUseId: 't1' }), greeted);
});

test('going to the terminal and back is a return', () => {
  const back = run(initialRendererState(), askedT1, { type: 'answersGreeted', toolUseId: 't1' },
    { type: 'answerViewChosen', toolUseId: 't1', view: 'terminal' });
  assert.strictEqual(back.answers.byToolUse.t1.view, 'terminal');
  const returned = run(back, { type: 'answerViewChosen', toolUseId: 't1', view: 'questions' });
  assert.deepStrictEqual(returned.answers.byToolUse.t1.said, { seq: 2, moment: { kind: 'returned' } });
});

test('pokes count up, and each is a new line', () => {
  const state = run(initialRendererState(), askedT1,
    { type: 'answersPatchPoked', toolUseId: 't1' }, { type: 'answersPatchPoked', toolUseId: 't1' });
  assert.strictEqual(state.answers.byToolUse.t1.pokes, 2);
  assert.deepStrictEqual(state.answers.byToolUse.t1.said, { seq: 2, moment: { kind: 'poked', count: 2 } });
});

test('dozing says so once per minute-left', () => {
  const dozed = run(initialRendererState(), askedT1, { type: 'answersDozed', toolUseId: 't1', minutesLeft: 3 });
  assert.deepStrictEqual(dozed.answers.byToolUse.t1.said?.moment, { kind: 'waiting', minutesLeft: 3 });
  assert.strictEqual(rootReducer(dozed, { type: 'answersDozed', toolUseId: 't1', minutesLeft: 3 }), dozed);
  assert.strictEqual(run(dozed, { type: 'answersDozed', toolUseId: 't1', minutesLeft: 2 }).answers.byToolUse.t1.dozedAt, 2);
});

test('the prompts to act leave the state as it was', () => {
  const state = run(initialRendererState(), askedT1);
  assert.strictEqual(rootReducer(state, { type: 'answersDelivered', toolUseId: 't1' }), state);
  assert.strictEqual(rootReducer(state, { type: 'emptyScreenShown' }), state);
});
