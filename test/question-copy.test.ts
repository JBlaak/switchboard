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

const at = (minutes: number) => 60_000 * minutes;

test('the counter names the step', () => {
  /* When */
  const counter = questionCounter(0, 3, question(2));

  /* Then */
  assert.equal(counter, 'Question 1 of 3');
});

test('the counter says when any number may be picked', () => {
  /* When */
  const counter = questionCounter(2, 3, question(4, true));

  /* Then */
  assert.equal(counter, 'Question 3 of 3 · pick any');
});

test('key hints count the Other row in the pick range', () => {
  /* When */
  const hints = keyHints(question(3));

  /* Then */
  assert.deepEqual(hints.map(h => h.key), ['↑↓', '1–4', '←→']);
  assert.deepEqual(hints.map(h => h.does), ['choose', 'pick', 'questions']);
});

test('key hints for multiple choice add the space toggle', () => {
  /* When */
  const hints = keyHints(question(4, true));

  /* Then */
  assert.deepEqual(hints.map(h => h.key), ['↑↓', '1–5', 'space', '←→']);
});

test('key hints cap the pick range at 9', () => {
  /* When */
  const hints = keyHints(question(12));

  /* Then */
  assert.equal(hints[1].key, '1–9');
});

test('the waiting pill counts what is left', () => {
  /* Given */
  const cases: Array<[number, string]> = [
    [3, '3 questions waiting · Show'],
    [1, '1 question waiting · Show'],
  ];

  for (const [left, expected] of cases) {
    /* When */
    const label = waitingLabel(left);

    /* Then */
    assert.equal(label, expected);
  }
});

test('the waiting pill says when nothing is left', () => {
  /* When */
  const label = waitingLabel(0);

  /* Then */
  assert.equal(label, 'Ready to send · Show');
});

test('the answered foot counts answered questions out of the total', () => {
  /* When */
  const foot = answeredFoot(1, 3);

  /* Then */
  assert.equal(foot, '1 of 3 answered');
});

test('minutes left round up', () => {
  /* Given */
  const cases: Array<[number, number]> = [
    [60_000 * 2 + 1, 3],
    [60_000 * 2, 2],
  ];

  for (const [deadline, expected] of cases) {
    /* When */
    const left = minutesLeft(deadline, 0);

    /* Then */
    assert.equal(left, expected);
  }
});

test('minutes left stop at zero', () => {
  /* When */
  const left = minutesLeft(-5, 0);

  /* Then */
  assert.equal(left, 0);
});

test('Patch does not doze before the window', () => {
  /* When */
  const minute = dozeMinute(at(DOZE_FROM_MINUTES + 1), 0, null);

  /* Then */
  assert.equal(minute, null);
});

test('Patch dozes on entering the window', () => {
  /* When */
  const minute = dozeMinute(at(DOZE_FROM_MINUTES), 0, null);

  /* Then */
  assert.equal(minute, DOZE_FROM_MINUTES);
});

test('Patch dozes only once per minute', () => {
  /* When */
  const minute = dozeMinute(at(DOZE_FROM_MINUTES) - 1000, 0, DOZE_FROM_MINUTES);

  /* Then */
  assert.equal(minute, null);
});

test('Patch dozes again when a new minute starts', () => {
  /* When */
  const minute = dozeMinute(at(1), 0, 2);

  /* Then */
  assert.equal(minute, 1);
});

test('Patch does not doze once time is up', () => {
  /* When */
  const minute = dozeMinute(0, 0, null);

  /* Then */
  assert.equal(minute, null);
});
