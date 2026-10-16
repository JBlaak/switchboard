import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionBeat, type QuestionMoment } from '../src/domain/companion/question-beats';

const line = (moment: QuestionMoment) => questionBeat(moment).line;

test('arriving counts the questions, singular for one', () => {
  assert.deepEqual(questionBeat({ kind: 'arrived', count: 3 }), {
    move: 'wave', mood: 'happy', line: 'Claude has 3 questions for you. I’ll keep count!',
  });
  assert.equal(line({ kind: 'arrived', count: 1 }), 'Claude has a question for you. I’ll keep count!');
});

test('a pick is cheered differently when it is the recommended one', () => {
  assert.deepEqual(questionBeat({ kind: 'picked', recommended: true }), {
    move: 'hop', mood: 'happy', line: 'Good call. Claude liked that one too.',
  });
  assert.deepEqual(questionBeat({ kind: 'picked', recommended: false }), {
    move: 'twirl', mood: 'happy', line: 'Going your own way. I like it.',
  });
  assert.deepEqual(questionBeat({ kind: 'unpicked' }), { move: 'peek', mood: 'calm', line: 'Changed your mind? Fair.' });
});

test('multi-count spells out the count, and notices none and all', () => {
  assert.equal(line({ kind: 'multi-count', count: 1, total: 4 }), 'One picked. Any more?');
  assert.equal(line({ kind: 'multi-count', count: 2, total: 4 }), 'Two picked. Any more?');
  assert.equal(line({ kind: 'multi-count', count: 3, total: 4 }), 'Three picked. Any more?');
  assert.equal(line({ kind: 'multi-count', count: 0, total: 4 }), 'Nothing picked yet…');
  assert.deepEqual(questionBeat({ kind: 'multi-count', count: 4, total: 4 }), {
    move: 'jelly', mood: 'happy', line: 'All of them? Bold.',
  });
});

test('writing an own answer and finishing the set', () => {
  assert.deepEqual(questionBeat({ kind: 'started-other' }), { move: 'peek', mood: 'calm', line: 'Ooh, writing your own answer.' });
  assert.deepEqual(questionBeat({ kind: 'all-answered' }), { move: 'hop', mood: 'happy', line: 'That’s everything. Send it!' });
});

test('advancing counts down in words, and calls out the last question', () => {
  assert.equal(line({ kind: 'advanced', done: 1, total: 3, isLast: false }), 'One down, two to go.');
  assert.equal(line({ kind: 'advanced', done: 2, total: 4, isLast: false }), 'Two down, two to go.');
  assert.equal(line({ kind: 'advanced', done: 2, total: 3, isLast: true }), 'Last one!');
  assert.equal(line({ kind: 'advanced', done: 3, total: 3, isLast: false }), 'All answered. Onward!');
});

test('moving to a tab names it', () => {
  assert.deepEqual(questionBeat({ kind: 'moved-to', header: 'Timeout' }), { move: 'peek', mood: 'calm', line: 'Back to Timeout.' });
});

test('being blocked worries Patch, with its own line on the last question', () => {
  assert.deepEqual(questionBeat({ kind: 'blocked', isLast: false }), { move: 'jelly', mood: 'worried', line: 'Pick one first!' });
  assert.equal(line({ kind: 'blocked', isLast: true }), 'Almost! One still needs an answer.');
});

test('coming back', () => {
  assert.equal(line({ kind: 'returned' }), 'Welcome back. Right where you left off.');
});

test('pokes cycle through four lines', () => {
  const lines = [1, 2, 3, 4, 5].map(count => line({ kind: 'poked', count }));
  assert.deepEqual(lines, [
    'Hey! I’m counting.',
    'Hehe. That tickles.',
    'Okay okay, I’m watching.',
    'Answer the questions, not me!',
    'Hey! I’m counting.',
  ]);
  assert.equal(questionBeat({ kind: 'poked', count: 1 }).move, 'jelly');
});

test('waiting dozes and says when the terminal takes over', () => {
  assert.deepEqual(questionBeat({ kind: 'waiting', minutesLeft: 3 }), {
    move: 'doze', mood: 'tired', line: 'Still here. The terminal takes over in 3 min.',
  });
  assert.equal(line({ kind: 'waiting', minutesLeft: 1 }), 'Still here. The terminal takes over in a minute.');
});

test('sending', () => {
  assert.deepEqual(questionBeat({ kind: 'sent' }), { move: 'love', mood: 'happy', line: 'Off it goes!' });
  assert.deepEqual(questionBeat({ kind: 'submit' }), questionBeat({ kind: 'sent' }));
});
