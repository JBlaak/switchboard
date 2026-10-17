import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questionBeat, type QuestionMoment } from '../src/domain/companion/question-beats';

const line = (moment: QuestionMoment) => questionBeat(moment).line;

test('arriving counts the questions', () => {
  /* When */
  const beat = questionBeat({ kind: 'arrived', count: 3 });

  /* Then */
  assert.deepEqual(beat, {
    move: 'wave', mood: 'happy', line: 'Claude has 3 questions for you. I’ll keep count!',
  });
});

test('arriving with one question says it in the singular', () => {
  /* When */
  const said = line({ kind: 'arrived', count: 1 });

  /* Then */
  assert.equal(said, 'Claude has a question for you. I’ll keep count!');
});

test('picking the recommended option is cheered as a good call', () => {
  /* When */
  const beat = questionBeat({ kind: 'picked', recommended: true });

  /* Then */
  assert.deepEqual(beat, {
    move: 'hop', mood: 'happy', line: 'Good call. Claude liked that one too.',
  });
});

test('picking another option is cheered as going your own way', () => {
  /* When */
  const beat = questionBeat({ kind: 'picked', recommended: false });

  /* Then */
  assert.deepEqual(beat, {
    move: 'twirl', mood: 'happy', line: 'Going your own way. I like it.',
  });
});

test('unpicking notices the change of mind', () => {
  /* When */
  const beat = questionBeat({ kind: 'unpicked' });

  /* Then */
  assert.deepEqual(beat, { move: 'peek', mood: 'calm', line: 'Changed your mind? Fair.' });
});

test('multi-count spells out the count', () => {
  /* Given */
  const cases: Array<[number, string]> = [
    [1, 'One picked. Any more?'],
    [2, 'Two picked. Any more?'],
    [3, 'Three picked. Any more?'],
  ];

  for (const [count, expected] of cases) {
    /* When */
    const said = line({ kind: 'multi-count', count, total: 4 });

    /* Then */
    assert.equal(said, expected);
  }
});

test('multi-count notices when nothing is picked', () => {
  /* When */
  const said = line({ kind: 'multi-count', count: 0, total: 4 });

  /* Then */
  assert.equal(said, 'Nothing picked yet…');
});

test('multi-count notices when everything is picked', () => {
  /* When */
  const beat = questionBeat({ kind: 'multi-count', count: 4, total: 4 });

  /* Then */
  assert.deepEqual(beat, {
    move: 'jelly', mood: 'happy', line: 'All of them? Bold.',
  });
});

test('writing an own answer', () => {
  /* When */
  const beat = questionBeat({ kind: 'started-other' });

  /* Then */
  assert.deepEqual(beat, { move: 'peek', mood: 'calm', line: 'Ooh, writing your own answer.' });
});

test('finishing the set', () => {
  /* When */
  const beat = questionBeat({ kind: 'all-answered' });

  /* Then */
  assert.deepEqual(beat, { move: 'hop', mood: 'happy', line: 'That’s everything. Send it!' });
});

test('advancing counts down in words', () => {
  /* Given */
  const cases: Array<[number, number, string]> = [
    [1, 3, 'One down, two to go.'],
    [2, 4, 'Two down, two to go.'],
  ];

  for (const [done, total, expected] of cases) {
    /* When */
    const said = line({ kind: 'advanced', done, total, isLast: false });

    /* Then */
    assert.equal(said, expected);
  }
});

test('advancing calls out the last question', () => {
  /* When */
  const said = line({ kind: 'advanced', done: 2, total: 3, isLast: true });

  /* Then */
  assert.equal(said, 'Last one!');
});

test('advancing past every question says all are answered', () => {
  /* When */
  const said = line({ kind: 'advanced', done: 3, total: 3, isLast: false });

  /* Then */
  assert.equal(said, 'All answered. Onward!');
});

test('moving to a tab names it', () => {
  /* When */
  const beat = questionBeat({ kind: 'moved-to', header: 'Timeout' });

  /* Then */
  assert.deepEqual(beat, { move: 'peek', mood: 'calm', line: 'Back to Timeout.' });
});

test('being blocked worries Patch', () => {
  /* When */
  const beat = questionBeat({ kind: 'blocked', isLast: false });

  /* Then */
  assert.deepEqual(beat, { move: 'jelly', mood: 'worried', line: 'Pick one first!' });
});

test('being blocked on the last question has its own line', () => {
  /* When */
  const said = line({ kind: 'blocked', isLast: true });

  /* Then */
  assert.equal(said, 'Almost! One still needs an answer.');
});

test('coming back', () => {
  /* When */
  const said = line({ kind: 'returned' });

  /* Then */
  assert.equal(said, 'Welcome back. Right where you left off.');
});

test('pokes cycle through four lines', () => {
  /* When */
  const lines = [1, 2, 3, 4, 5].map(count => line({ kind: 'poked', count }));

  /* Then */
  assert.deepEqual(lines, [
    'Hey! I’m counting.',
    'Hehe. That tickles.',
    'Okay okay, I’m watching.',
    'Answer the questions, not me!',
    'Hey! I’m counting.',
  ]);
});

test('a poke makes Patch jelly', () => {
  /* When */
  const beat = questionBeat({ kind: 'poked', count: 1 });

  /* Then */
  assert.equal(beat.move, 'jelly');
});

test('waiting dozes and says when the terminal takes over', () => {
  /* When */
  const beat = questionBeat({ kind: 'waiting', minutesLeft: 3 });

  /* Then */
  assert.deepEqual(beat, {
    move: 'doze', mood: 'tired', line: 'Still here. The terminal takes over in 3 min.',
  });
});

test('waiting with one minute left says a minute', () => {
  /* When */
  const said = line({ kind: 'waiting', minutesLeft: 1 });

  /* Then */
  assert.equal(said, 'Still here. The terminal takes over in a minute.');
});

test('sending', () => {
  /* When */
  const beat = questionBeat({ kind: 'sent' });

  /* Then */
  assert.deepEqual(beat, { move: 'love', mood: 'happy', line: 'Off it goes!' });
});

test('submitting reacts the same as sending', () => {
  /* When */
  const beat = questionBeat({ kind: 'submit' });

  /* Then */
  assert.deepEqual(beat, questionBeat({ kind: 'sent' }));
});
