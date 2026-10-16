import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answeredCount, createDraft, displayLabel, draftAnswers, isAnswered, isRecommended, reduceDraft,
  type AnswerDraft, type DraftAction, type DraftResult,
} from '../src/domain/questions/answer-draft';
import type { Question } from '../src/domain/questions/question';

function question(over: Partial<Question> & { labels?: string[] } = {}): Question {
  const { labels = ['Alpha', 'Beta', 'Gamma'], ...rest } = over;
  return {
    question: 'Which one?',
    header: 'Pick',
    options: labels.map(label => ({ label, description: '' })),
    multiSelect: false,
    ...rest,
  };
}

const single = question({ question: 'Timeout?', header: 'Timeout', labels: ['Short', 'Long (Recommended)', 'None'] });
const multi = question({ question: 'Features?', header: 'Features', labels: ['Logs', 'Metrics', 'Traces'], multiSelect: true });
const third = question({ question: 'Name?', header: '', labels: ['Foo', 'Bar'] });
const qs = [single, multi, third];

/** Runs actions in order, checking along the way that nothing handed in is ever mutated. */
function run(questions: Question[], actions: DraftAction[], from?: AnswerDraft): DraftResult {
  let result: DraftResult = { draft: from ?? createDraft(questions), event: null };
  for (const action of actions) {
    const before = structuredClone(result.draft);
    const input = result.draft;
    result = reduceDraft(questions, input, action);
    assert.deepEqual(input, before, `${action.kind} mutated its input`);
  }
  return result;
}

test('a fresh draft starts on the first question with nothing answered', () => {
  const draft = createDraft(qs);
  assert.deepEqual(draft, { step: 0, cursor: 0, picks: [[], [], []], other: ['', '', ''] });
  assert.equal(answeredCount(qs, draft), 0);
});

test('moving on a single-choice question picks quietly and wraps over the Other row', () => {
  let r = run(qs, [{ kind: 'move', by: 1 }]);
  assert.equal(r.event, null);
  assert.equal(r.draft.cursor, 1);
  assert.deepEqual(r.draft.picks[0], ['Long (Recommended)']);

  r = run(qs, [{ kind: 'move', by: -1 }]);
  assert.equal(r.draft.cursor, 3, 'up from the first row wraps to Other');
  assert.deepEqual(r.draft.picks[0], []);

  r = run(qs, [{ kind: 'move', by: -1 }, { kind: 'move', by: 1 }]);
  assert.equal(r.draft.cursor, 0, 'down from Other wraps to the first row');
  assert.deepEqual(r.draft.picks[0], ['Short']);
});

test('moving onto an option clears Other text; moving onto Other keeps it and drops the pick', () => {
  let r = run(qs, [{ kind: 'type', text: 'Five minutes' }, { kind: 'move', by: 1 }]);
  assert.equal(r.draft.cursor, 0);
  assert.deepEqual(r.draft.picks[0], ['Short']);
  assert.equal(r.draft.other[0], '');

  r = run(qs, [{ kind: 'press', row: 1 }, { kind: 'type', text: 'x' }, { kind: 'press', row: 0 }, { kind: 'move', by: -1 }]);
  assert.equal(r.draft.cursor, 3);
  assert.deepEqual(r.draft.picks[0], []);
});

test('moving on a multiple-choice question only moves the cursor', () => {
  const r = run([multi], [{ kind: 'move', by: 1 }, { kind: 'move', by: 1 }]);
  assert.equal(r.event, null);
  assert.equal(r.draft.cursor, 2);
  assert.deepEqual(r.draft.picks[0], []);
});

test('a move that completes the set stays quiet', () => {
  const r = run([single], [{ kind: 'move', by: 1 }]);
  assert.equal(r.event, null);
  assert.equal(answeredCount([single], r.draft), 1);
});

test('pressing an option picks it, says whether it was the recommended one, and the cursor follows', () => {
  let r = run(qs, [{ kind: 'press', row: 2 }]);
  assert.deepEqual(r.event, { kind: 'picked', recommended: false });
  assert.equal(r.draft.cursor, 2);
  assert.deepEqual(r.draft.picks[0], ['None']);

  r = run(qs, [{ kind: 'press', row: 1 }]);
  assert.deepEqual(r.event, { kind: 'picked', recommended: true });
});

test('pressing the picked option again keeps it and says nothing', () => {
  const r = run(qs, [{ kind: 'press', row: 1 }, { kind: 'move', by: 1 }, { kind: 'move', by: 1 }, { kind: 'press', row: 2 }, { kind: 'press', row: 2 }]);
  assert.equal(r.event, null);
  assert.deepEqual(r.draft.picks[0], ['None']);
});

test('picking an option on a single-choice question replaces the last pick and clears Other', () => {
  const r = run(qs, [{ kind: 'type', text: 'mine' }, { kind: 'press', row: 0 }, { kind: 'press', row: 2 }]);
  assert.deepEqual(r.draft.picks[0], ['None']);
  assert.equal(r.draft.other[0], '');
});

test('pressing the Other row moves the cursor there and drops a single-choice pick', () => {
  const r = run(qs, [{ kind: 'press', row: 0 }, { kind: 'press', row: 3 }]);
  assert.equal(r.event, null);
  assert.equal(r.draft.cursor, 3);
  assert.deepEqual(r.draft.picks[0], []);
});

test('pressing the Other row on a multiple-choice question keeps the picks', () => {
  const r = run([multi], [{ kind: 'press', row: 0 }, { kind: 'press', row: 3 }]);
  assert.equal(r.draft.cursor, 3);
  assert.deepEqual(r.draft.picks[0], ['Logs']);
});

test('pressing a row that does not exist does nothing', () => {
  const draft = createDraft(qs);
  for (const row of [-1, 4, 1.5]) {
    const r = reduceDraft(qs, draft, { kind: 'press', row });
    assert.equal(r.draft, draft);
    assert.equal(r.event, null);
  }
});

test('toggles on a multiple-choice question report the count and keep picks in option order', () => {
  let r = run([multi, single], [{ kind: 'press', row: 2 }]);
  assert.deepEqual(r.event, { kind: 'multi-count', count: 1, total: 3 });
  r = run([multi, single], [{ kind: 'press', row: 2 }, { kind: 'press', row: 0 }]);
  assert.deepEqual(r.event, { kind: 'multi-count', count: 2, total: 3 });
  assert.deepEqual(r.draft.picks[0], ['Logs', 'Traces']);
  r = run([multi, single], [{ kind: 'press', row: 2 }, { kind: 'press', row: 0 }, { kind: 'press', row: 2 }]);
  assert.deepEqual(r.event, { kind: 'multi-count', count: 1, total: 3 });
  assert.deepEqual(r.draft.picks[0], ['Logs']);
  assert.equal(r.draft.cursor, 2);
});

test('the multi count leaves Other text out', () => {
  const r = run([multi, single], [{ kind: 'type', text: 'Profiles' }, { kind: 'press', row: 1 }]);
  assert.deepEqual(r.event, { kind: 'multi-count', count: 1, total: 3 });
  assert.equal(r.draft.other[0], 'Profiles', 'Other is one more thing to include, not a rival');
});

test('clicking the picked option of a single-choice question unpicks it', () => {
  const r = run(qs, [{ kind: 'click', row: 1 }, { kind: 'click', row: 1 }]);
  assert.deepEqual(r.event, { kind: 'unpicked' });
  assert.deepEqual(r.draft.picks[0], []);
  assert.equal(r.draft.cursor, 1);
});

test('clicking otherwise behaves like pressing', () => {
  assert.deepEqual(run(qs, [{ kind: 'click', row: 0 }]).event, { kind: 'picked', recommended: false });
  const r = run([multi, single], [{ kind: 'click', row: 0 }, { kind: 'click', row: 0 }]);
  assert.deepEqual(r.event, { kind: 'multi-count', count: 0, total: 3 });
});

test('space presses the row under the cursor, and does nothing on Other', () => {
  let r = run([multi, single], [{ kind: 'move', by: 1 }, { kind: 'space' }]);
  assert.deepEqual(r.draft.picks[0], ['Metrics']);
  assert.deepEqual(r.event, { kind: 'multi-count', count: 1, total: 3 });

  const onOther = run([multi, single], [{ kind: 'move', by: -1 }]).draft;
  r = reduceDraft([multi, single], onOther, { kind: 'space' });
  assert.equal(r.draft, onOther);
  assert.equal(r.event, null);
});

test('focusing Other is pressing its row', () => {
  const r = run(qs, [{ kind: 'press', row: 0 }, { kind: 'focus-other' }]);
  assert.equal(r.draft.cursor, 3);
  assert.deepEqual(r.draft.picks[0], []);
  assert.equal(r.event, null);
});

test('typing sets Other, drops a single-choice pick and announces only the first non-blank text', () => {
  let r = run(qs, [{ kind: 'press', row: 0 }, { kind: 'type', text: '   ' }]);
  assert.equal(r.event, null, 'blank text is not an answer yet');
  assert.deepEqual(r.draft.picks[0], []);
  assert.equal(r.draft.cursor, 3);

  r = run(qs, [{ kind: 'type', text: '   ' }, { kind: 'type', text: ' 5m' }]);
  assert.deepEqual(r.event, { kind: 'started-other' });
  r = run(qs, [{ kind: 'type', text: '5' }, { kind: 'type', text: '5m' }]);
  assert.equal(r.event, null);
  assert.equal(r.draft.other[0], '5m');
});

test('typing on a multiple-choice question keeps the picks', () => {
  const r = run([multi, single], [{ kind: 'press', row: 0 }, { kind: 'type', text: 'Profiles' }]);
  assert.deepEqual(r.draft.picks[0], ['Logs']);
  assert.equal(r.draft.cursor, 3);
});

test('isAnswered counts a pick or non-blank Other text', () => {
  let draft = createDraft(qs);
  assert.equal(isAnswered(qs, draft, 0), false);
  draft = run(qs, [{ kind: 'type', text: '  ' }]).draft;
  assert.equal(isAnswered(qs, draft, 0), false);
  draft = run(qs, [{ kind: 'type', text: 'x' }]).draft;
  assert.equal(isAnswered(qs, draft, 0), true);
  draft = run(qs, [{ kind: 'press', row: 0 }]).draft;
  assert.equal(isAnswered(qs, draft, 0), true);
  assert.equal(isAnswered(qs, draft, 7), false);
});

test('next is blocked until the current question is answered', () => {
  const r = run(qs, [{ kind: 'next' }]);
  assert.deepEqual(r.event, { kind: 'blocked', isLast: false });
  assert.equal(r.draft.step, 0);
});

test('next advances with the answered count and whether it landed on the last question', () => {
  let r = run(qs, [{ kind: 'press', row: 0 }, { kind: 'next' }]);
  assert.deepEqual(r.event, { kind: 'advanced', done: 1, total: 3, isLast: false });
  assert.equal(r.draft.step, 1);
  assert.equal(r.draft.cursor, 0);

  r = run(qs, [{ kind: 'press', row: 0 }, { kind: 'next' }, { kind: 'press', row: 1 }, { kind: 'next' }]);
  assert.deepEqual(r.event, { kind: 'advanced', done: 2, total: 3, isLast: true });
  assert.equal(r.draft.step, 2);
});

test('next on the last question submits when everything is answered, without touching the draft', () => {
  const answered = run(qs, [
    { kind: 'press', row: 0 }, { kind: 'next' },
    { kind: 'press', row: 1 }, { kind: 'next' },
    { kind: 'press', row: 1 },
  ]).draft;
  const r = reduceDraft(qs, answered, { kind: 'next' });
  assert.deepEqual(r.event, { kind: 'submit' });
  assert.equal(r.draft, answered);
});

test('next on the last question is blocked while an earlier one is unanswered', () => {
  const r = run(qs, [{ kind: 'goto', step: 2 }, { kind: 'press', row: 0 }, { kind: 'next' }]);
  assert.deepEqual(r.event, { kind: 'blocked', isLast: true });
  assert.equal(r.draft.step, 2);

  const blank = run(qs, [{ kind: 'goto', step: 2 }, { kind: 'next' }]);
  assert.deepEqual(blank.event, { kind: 'blocked', isLast: true });
});

test('answering the last open question announces it instead of the usual event', () => {
  let r = run(qs, [{ kind: 'press', row: 0 }, { kind: 'next' }, { kind: 'press', row: 1 }, { kind: 'next' }, { kind: 'press', row: 0 }]);
  assert.deepEqual(r.event, { kind: 'all-answered' });

  r = run(qs, [{ kind: 'press', row: 0 }, { kind: 'next' }, { kind: 'press', row: 1 }, { kind: 'next' }, { kind: 'type', text: 'Baz' }]);
  assert.deepEqual(r.event, { kind: 'all-answered' });

  r = run([multi], [{ kind: 'press', row: 0 }]);
  assert.deepEqual(r.event, { kind: 'all-answered' });
  r = run([multi], [{ kind: 'press', row: 0 }, { kind: 'press', row: 1 }]);
  assert.deepEqual(r.event, { kind: 'multi-count', count: 2, total: 3 }, 'already all answered');
});

test('re-answering after unpicking announces everything again', () => {
  const r = run([single], [{ kind: 'click', row: 0 }, { kind: 'click', row: 0 }, { kind: 'click', row: 2 }]);
  assert.deepEqual(r.event, { kind: 'all-answered' });
});

test('back goes to the previous question with the cursor on its pick', () => {
  const r = run(qs, [{ kind: 'press', row: 2 }, { kind: 'next' }, { kind: 'back' }]);
  assert.deepEqual(r.event, { kind: 'moved-to', header: 'Timeout' });
  assert.equal(r.draft.step, 0);
  assert.equal(r.draft.cursor, 2);
});

test('back on the first question does nothing', () => {
  const draft = createDraft(qs);
  const r = reduceDraft(qs, draft, { kind: 'back' });
  assert.equal(r.draft, draft);
  assert.equal(r.event, null);
});

test('landing on a question with only Other text puts the cursor on Other', () => {
  const r = run(qs, [{ kind: 'type', text: 'Ten' }, { kind: 'next' }, { kind: 'back' }]);
  assert.equal(r.draft.cursor, 3);
});

test('landing on a multiple-choice question with picks puts the cursor on the first row', () => {
  const r = run(qs, [{ kind: 'goto', step: 1 }, { kind: 'press', row: 2 }, { kind: 'goto', step: 0 }, { kind: 'goto', step: 1 }]);
  assert.equal(r.draft.cursor, 0);
});

test('goto jumps without the answered check and names where it landed, falling back to the number', () => {
  let r = run(qs, [{ kind: 'goto', step: 2 }]);
  assert.deepEqual(r.event, { kind: 'moved-to', header: 'Question 3' });
  assert.equal(r.draft.step, 2);
  assert.equal(r.draft.cursor, 0);

  r = run(qs, [{ kind: 'goto', step: 1 }]);
  assert.deepEqual(r.event, { kind: 'moved-to', header: 'Features' });
});

test('goto the current or a missing question does nothing', () => {
  const draft = createDraft(qs);
  for (const step of [0, -1, 3]) {
    const r = reduceDraft(qs, draft, { kind: 'goto', step });
    assert.equal(r.draft, draft);
    assert.equal(r.event, null);
  }
});

test('draftAnswers keeps option order and the Recommended suffix, then trimmed Other text', () => {
  const draft = run(qs, [
    { kind: 'press', row: 1 },
    { kind: 'goto', step: 1 }, { kind: 'press', row: 2 }, { kind: 'press', row: 0 }, { kind: 'type', text: '  Profiles  ' },
    { kind: 'goto', step: 2 }, { kind: 'type', text: ' Qux ' },
  ]).draft;
  assert.deepEqual(draftAnswers(qs, draft), {
    'Timeout?': 'Long (Recommended)',
    'Features?': 'Logs, Traces, Profiles',
    'Name?': 'Qux',
  });
});

test('isRecommended reads Claude’s suffix loosely; displayLabel strips it', () => {
  assert.equal(isRecommended('Long (Recommended)'), true);
  assert.equal(isRecommended('Long (recommended)  '), true);
  assert.equal(isRecommended('Long'), false);
  assert.equal(isRecommended('(Recommended) Long'), false);
  assert.equal(displayLabel('Long (Recommended)'), 'Long');
  assert.equal(displayLabel('  Long (RECOMMENDED) '), 'Long');
  assert.equal(displayLabel('Long'), 'Long');
});
