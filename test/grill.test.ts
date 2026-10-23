import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRILL_YES_LABEL, WAIT_WHAT_LABEL, grillReply, parseGrillRound,
} from '../src/domain/questions/grill';
import type { Question } from '../src/domain/questions/question';

/**
 * A grilling round as the `grilling` skill writes it, read back into the
 * questions the panel draws, and the answers turned into the prompt it types.
 */

const ROUND = [
  'Settled last round: the cache stays in memory.',
  '',
  '❓ **Q1** - **Keep the old API?**: Two callers still use it.',
  'Dropping it now means touching both.',
  '',
  '➡️ Keep it for one more release, then drop it.',
  '',
  '---',
  '',
  '❓ **Q2** - **Which store?**: Pick where sessions live.',
  '',
  '- **A)** SQLite — one file, no server',
  '- **B)** Postgres — shared, needs a server',
  '',
  '➡️ A, SQLite: nothing else needs a server yet.',
].join('\n');

test('each block becomes a question titled and numbered as the round gave it', () => {
  /* When */
  const questions = parseGrillRound(ROUND);

  /* Then */
  assert.deepEqual(questions?.map(q => [q.header, q.question, q.multiSelect]), [
    ['Q1', 'Keep the old API?', false],
    ['Q2', 'Which store?', false],
  ]);
});

test('the recommendation is the first row, Wait-what the last', () => {
  /* When */
  const [first] = parseGrillRound(ROUND) ?? [];

  /* Then */
  assert.deepEqual(first.options, [
    { label: GRILL_YES_LABEL, description: 'Keep it for one more release, then drop it.' },
    { label: WAIT_WHAT_LABEL, description: 'Have Claude re-pitch this one in plain words (/wait-what)' },
  ]);
  assert.equal(first.detail, 'Two callers still use it.\nDropping it now means touching both.');
});

test('the choices a body lists become rows, and leave the detail', () => {
  /* When */
  const [, second] = parseGrillRound(ROUND) ?? [];

  /* Then */
  assert.deepEqual(second.options.map(o => [o.label, o.description]), [
    [GRILL_YES_LABEL, 'A, SQLite: nothing else needs a server yet.'],
    ['A) SQLite', 'one file, no server'],
    ['B) Postgres', 'shared, needs a server'],
    [WAIT_WHAT_LABEL, 'Have Claude re-pitch this one in plain words (/wait-what)'],
  ]);
  assert.equal(second.detail, 'Pick where sessions live.');
});

test('numbered and lettered lists are choices too', () => {
  /* Given */
  const text = '❓ **Q1** - **Layout?**: Options:\n1. Tabs\n2. Split view\n\n➡️ Tabs.';

  /* When */
  const [question] = parseGrillRound(text) ?? [];

  /* Then */
  assert.deepEqual(question.options.map(o => o.label), [GRILL_YES_LABEL, '1. Tabs', '2. Split view', WAIT_WHAT_LABEL]);
  assert.equal(question.detail, 'Options:');
});

test('a single list item, or a long list, stays in the detail', () => {
  /* Given */
  const one = '❓ **Q1** - **Ship?**: Left to do:\n- docs\n\n➡️ Yes.';
  const many = '❓ **Q1** - **Ship?**: Left to do:\n' + ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(x => `- ${x}`).join('\n') + '\n\n➡️ Yes.';

  /* When */
  const [single] = parseGrillRound(one) ?? [];
  const [long] = parseGrillRound(many) ?? [];

  /* Then */
  assert.equal(single.options.length, 2);
  assert.equal(single.detail, 'Left to do:\n- docs');
  assert.equal(long.options.length, 2);
});

test('the looser openings are read too', () => {
  /* Given */
  const text = [
    '❓ **Q3 - Rename it?**: The name is taken.',
    '➡️ Yes, call it Relay.',
    '',
    '❓ Q4 - Now or later: Either works.',
    '➡️ Now.',
  ].join('\n');

  /* When */
  const questions = parseGrillRound(text);

  /* Then */
  assert.deepEqual(questions?.map(q => [q.header, q.question]), [['Q3', 'Rename it?'], ['Q4', 'Now or later']]);
});

test('a recommendation running over several lines is kept whole, without the rule', () => {
  /* Given */
  const text = '❓ **Q1** - **Split it?**: Big file.\n\n➡️ Yes: one module per concern,\nwith the parser on its own.\n\n---\n';

  /* When */
  const [question] = parseGrillRound(text) ?? [];

  /* Then */
  assert.equal(question.options[0].description, 'Yes: one module per concern,\nwith the parser on its own.');
});

test('text that is not a round gives nothing', () => {
  /* When */
  const parsed = [
    parseGrillRound('All tests pass. ❓ nothing to ask.'),
    parseGrillRound('❓ **Q1** - **No recommendation?**: none given.'),
    parseGrillRound('❓ Just a thought, no number.\n➡️ ok'),
    parseGrillRound(''),
  ];

  /* Then */
  assert.deepEqual(parsed, [null, null, null, null]);
});

test('a block without a recommendation is passed over, the rest still read', () => {
  /* Given */
  const text = '❓ **Q1** - **Half?**: no arrow\n\n---\n\n❓ **Q2** - **Whole?**: yes\n\n➡️ Yes.';

  /* When */
  const questions = parseGrillRound(text);

  /* Then */
  assert.deepEqual(questions?.map(q => q.header), ['Q2']);
});

// ── The reply ──

const QUESTIONS: Question[] = parseGrillRound(ROUND) ?? [];

test('yes, a choice and a typed answer each get a line', () => {
  /* Given */
  const three: Question[] = [...QUESTIONS, { ...QUESTIONS[0], question: 'Third?', header: 'Q3' }];

  /* When */
  const reply = grillReply(three, {
    'Keep the old API?': GRILL_YES_LABEL,
    'Which store?': 'B) Postgres',
    'Third?': 'Only if it is cheap',
  });

  /* Then */
  assert.equal(reply, 'Q1: yes\nQ2: B) Postgres — shared, needs a server\nQ3: Only if it is cheap');
});

test('wait-what asks for a re-pitch and carries the other answers', () => {
  /* When */
  const reply = grillReply(QUESTIONS, { 'Keep the old API?': GRILL_YES_LABEL, 'Which store?': WAIT_WHAT_LABEL });

  /* Then */
  assert.equal(reply, '/wait-what Q2\n\nMy answers to the rest:\nQ1: yes');
});

test('wait-what on every question is the command alone', () => {
  /* When */
  const reply = grillReply(QUESTIONS, { 'Keep the old API?': WAIT_WHAT_LABEL, 'Which store?': WAIT_WHAT_LABEL });

  /* Then */
  assert.equal(reply, '/wait-what Q1 Q2');
});
