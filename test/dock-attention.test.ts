import { test } from 'node:test';
import assert from 'node:assert';
import { createStore } from '../src/renderer/state/store';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { installDockAttention, needsInputCount } from '../src/renderer/state/dock-attention';
import type { RendererEvent } from '../src/renderer/state/events';
import type { PendingQuestions } from '../src/domain/questions/question';

function asked(sessionId: string): PendingQuestions {
  return {
    sessionId,
    toolUseId: `t-${sessionId}`,
    source: 'ask',
    questions: [{ question: 'Scope?', header: 'Scope', multiSelect: false, options: [{ label: 'Site', description: '' }] }],
    askedAt: 0,
    deadline: 600_000,
  };
}

const blocked = (sessionId: string): RendererEvent => ({ type: 'sessionNeedsAttention', sessionId });

function setup() {
  const store = createStore(rootReducer, initialRendererState(null));
  const sent: number[] = [];
  installDockAttention(store, (count) => sent.push(count));
  return { store, sent };
}

test('needs input: a session blocked and one asking questions count once each', () => {
  /* Given */
  const store = createStore(rootReducer, initialRendererState(null));

  /* When */
  store.dispatch(blocked('s1'));
  store.dispatch({ type: 'questionsAsked', pending: asked('s2') });

  /* Then */
  assert.strictEqual(needsInputCount(store.getState()), 2);
});

test('needs input: a session both blocked and asking counts once', () => {
  /* Given */
  const store = createStore(rootReducer, initialRendererState(null));

  /* When */
  store.dispatch(blocked('s1'));
  store.dispatch({ type: 'questionsAsked', pending: asked('s1') });

  /* Then */
  assert.strictEqual(needsInputCount(store.getState()), 1);
});

test('dock: nothing is sent while nothing needs input', () => {
  /* When */
  const { sent } = setup();

  /* Then */
  assert.deepStrictEqual(sent, []);
});

test('dock: the count is sent as sessions start and stop needing input', () => {
  /* Given */
  const { store, sent } = setup();

  /* When */
  store.dispatch(blocked('s1'));
  store.dispatch(blocked('s2'));
  store.dispatch({ type: 'sessionViewed', sessionId: 's1' });
  store.dispatch({ type: 'activityCleared', sessionId: 's2' });

  /* Then */
  assert.deepStrictEqual(sent, [1, 2, 1, 0]);
});

test('dock: the same count again is not sent twice', () => {
  /* Given */
  const { store, sent } = setup();
  store.dispatch(blocked('s1'));

  /* When */
  store.dispatch(blocked('s1'));
  store.dispatch({ type: 'cliBusyState', sessionId: 's2', busy: true });

  /* Then */
  assert.deepStrictEqual(sent, [1]);
});
