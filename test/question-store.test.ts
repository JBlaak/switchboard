import { test } from 'node:test';
import assert from 'node:assert';
import { getState } from '../src/renderer/state/app-store';
import { addPendingQuestions, askingCount, settleQuestions } from '../src/renderer/state/question-store';
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

test('asking counts the questions and starts an entry for the set', () => {
  /* When */
  addPendingQuestions(asked('qa', 'qa-t'));

  /* Then */
  assert.strictEqual(askingCount('qa'), 1);
  assert.strictEqual(getState().answers.byToolUse['qa-t']?.view, 'questions');
});

test('settling ends the count and the entry', () => {
  /* Given */
  addPendingQuestions(asked('qb', 'qb-t'));

  /* When */
  settleQuestions({ sessionId: 'qb', toolUseId: 'qb-t', outcome: 'answered' });

  /* Then */
  assert.strictEqual(askingCount('qb'), 0);
  assert.strictEqual(getState().answers.byToolUse['qb-t'], undefined);
});
