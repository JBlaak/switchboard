import { test } from 'node:test';
import assert from 'node:assert';
import { dispatch } from '../src/renderer/state/app-store';
import {
  addPendingQuestions, askingCount, onQuestionsChange, questionsFor, settleQuestions,
} from '../src/renderer/state/question-store';
import type { QuestionChange } from '../src/renderer/state/question-store';
import type { PendingQuestions } from '../src/domain/questions/question';

// The adapter over the app's one store: these share it, so each uses its own ids.

function asked(sessionId: string, toolUseId: string): PendingQuestions {
  return {
    sessionId,
    toolUseId,
    questions: [{ question: 'q', header: 'h', multiSelect: false, options: [{ label: 'a', description: '' }] }] as never,
    askedAt: 0,
    deadline: 600_000,
  };
}

const changes: QuestionChange[] = [];
onQuestionsChange(change => changes.push(change));

test('the entry for a set is the same object for as long as it is pending', () => {
  addPendingQuestions(asked('qa', 'qa-t'));
  const entry = questionsFor('qa')!;
  entry.view = 'terminal';
  assert.strictEqual(questionsFor('qa'), entry);
  assert.strictEqual(questionsFor('qa')!.view, 'terminal');
  assert.strictEqual(askingCount('qa'), 1);
  assert.deepStrictEqual(changes.at(-1), { kind: 'asked', sessionId: 'qa' });
});

test('settling hands listeners the entry the panel was holding', () => {
  addPendingQuestions(asked('qb', 'qb-t'));
  const entry = questionsFor('qb');
  settleQuestions({ sessionId: 'qb', toolUseId: 'qb-t', outcome: 'answered' });
  const settled = changes.at(-1);
  assert.ok(settled?.kind === 'settled');
  assert.strictEqual(settled.entry, entry);
  assert.strictEqual(settled.outcome, 'answered');
  assert.strictEqual(questionsFor('qb'), undefined);
  assert.strictEqual(askingCount('qb'), 0);
});

test('a re-key keeps the entry, pointed at the new session id', () => {
  addPendingQuestions(asked('qc', 'qc-t'));
  const entry = questionsFor('qc')!;
  entry.pokes = 3;
  dispatch({ type: 'sessionForked', oldId: 'qc', newId: 'qc2' });
  assert.deepStrictEqual(changes.at(-1), { kind: 'rekeyed', oldId: 'qc', newId: 'qc2' });
  assert.strictEqual(questionsFor('qc2'), entry);
  assert.strictEqual(entry.pending.sessionId, 'qc2');
  assert.strictEqual(entry.pokes, 3);
});

test('a re-key of a session asking nothing says nothing', () => {
  const before = changes.length;
  dispatch({ type: 'sessionForked', oldId: 'nobody', newId: 'nobody2' });
  assert.strictEqual(changes.length, before);
});

test('a different set for the same session is a fresh entry', () => {
  addPendingQuestions(asked('qd', 'qd-1'));
  const first = questionsFor('qd')!;
  first.greeted = true;
  addPendingQuestions(asked('qd', 'qd-2'));
  assert.notStrictEqual(questionsFor('qd'), first);
  assert.strictEqual(questionsFor('qd')!.greeted, false);
});
