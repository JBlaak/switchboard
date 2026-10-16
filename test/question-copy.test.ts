import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answeredFoot, dozeMinute, keyHints, minutesLeft, questionCounter, waitingLabel,
} from '../src/renderer/features/questions/question-copy';
import { DOZE_FROM_MINUTES } from '../src/domain/companion/question-beats';
import type { Question } from '../src/domain/questions/question';

function question(options: number, multiSelect = false): Question {
  return {
    question: 'Which?',
    header: 'Pick',
    options: Array.from({ length: options }, (_, i) => ({ label: `Option ${i + 1}`, description: '' })),
    multiSelect,
  };
}

test('the counter names the step and says when any number may be picked', () => {
  assert.equal(questionCounter(0, 3, question(2)), 'Question 1 of 3');
  assert.equal(questionCounter(2, 3, question(4, true)), 'Question 3 of 3 · pick any');
});

test('key hints count the Other row and differ for multiple choice', () => {
  assert.deepEqual(keyHints(question(3)).map(h => h.key), ['↑↓', '1–4', '←→']);
  assert.deepEqual(keyHints(question(3)).map(h => h.does), ['choose', 'pick', 'questions']);
  assert.deepEqual(keyHints(question(4, true)).map(h => h.key), ['↑↓', '1–5', 'space', '←→']);
  assert.equal(keyHints(question(12))[1].key, '1–9');
});

test('the waiting pill counts what is left, and says when nothing is', () => {
  assert.equal(waitingLabel(3), '3 questions waiting · Show');
  assert.equal(waitingLabel(1), '1 question waiting · Show');
  assert.equal(waitingLabel(0), 'Ready to send · Show');
  assert.equal(answeredFoot(1, 3), '1 of 3 answered');
});

test('minutes left round up and stop at zero', () => {
  assert.equal(minutesLeft(60_000 * 2 + 1, 0), 3);
  assert.equal(minutesLeft(60_000 * 2, 0), 2);
  assert.equal(minutesLeft(-5, 0), 0);
});

test('Patch dozes inside the window, once per minute', () => {
  const at = (minutes: number) => 60_000 * minutes;
  assert.equal(dozeMinute(at(DOZE_FROM_MINUTES + 1), 0, null), null);
  assert.equal(dozeMinute(at(DOZE_FROM_MINUTES), 0, null), DOZE_FROM_MINUTES);
  assert.equal(dozeMinute(at(DOZE_FROM_MINUTES) - 1000, 0, DOZE_FROM_MINUTES), null);
  assert.equal(dozeMinute(at(1), 0, 2), 1);
  assert.equal(dozeMinute(0, 0, null), null);
});
