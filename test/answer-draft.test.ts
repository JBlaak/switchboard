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

/** The draft after some setup actions, checked for mutation like any other run. */
const after = (questions: Question[], actions: DraftAction[]): AnswerDraft => run(questions, actions).draft;

test('a fresh draft starts on the first question with nothing answered', () => {
  /* When */
  const draft = createDraft(qs);

  /* Then */
  assert.deepEqual(draft, { step: 0, cursor: 0, picks: [[], [], []], other: ['', '', ''] });
  assert.equal(answeredCount(qs, draft), 0);
});

test('moving on a single-choice question picks quietly', () => {
  /* When */
  const r = run(qs, [{ kind: 'move', by: 1 }]);

  /* Then */
  assert.equal(r.event, null);
  assert.equal(r.draft.cursor, 1);
  assert.deepEqual(r.draft.picks[0], ['Long (Recommended)']);
});

test('moving up from the first row wraps over to the Other row', () => {
  /* When */
  const r = run(qs, [{ kind: 'move', by: -1 }]);

  /* Then */
  assert.equal(r.draft.cursor, 3, 'up from the first row wraps to Other');
  assert.deepEqual(r.draft.picks[0], []);
});

test('moving down from the Other row wraps to the first row', () => {
  /* Given */
  const onOther = after(qs, [{ kind: 'move', by: -1 }]);

  /* When */
  const r = run(qs, [{ kind: 'move', by: 1 }], onOther);

  /* Then */
  assert.equal(r.draft.cursor, 0, 'down from Other wraps to the first row');
  assert.deepEqual(r.draft.picks[0], ['Short']);
});

test('moving onto an option clears Other text', () => {
  /* Given */
  const typed = after(qs, [{ kind: 'type', text: 'Five minutes' }]);

  /* When */
  const r = run(qs, [{ kind: 'move', by: 1 }], typed);

  /* Then */
  assert.equal(r.draft.cursor, 0);
  assert.deepEqual(r.draft.picks[0], ['Short']);
  assert.equal(r.draft.other[0], '');
});

test('moving onto Other drops the pick', () => {
  /* Given */
  const picked = after(qs, [{ kind: 'press', row: 1 }, { kind: 'type', text: 'x' }, { kind: 'press', row: 0 }]);

  /* When */
  const r = run(qs, [{ kind: 'move', by: -1 }], picked);

  /* Then */
  assert.equal(r.draft.cursor, 3);
  assert.deepEqual(r.draft.picks[0], []);
});

test('moving on a multiple-choice question only moves the cursor', () => {
  /* Given */
  const moved = after([multi], [{ kind: 'move', by: 1 }]);

  /* When */
  const r = run([multi], [{ kind: 'move', by: 1 }], moved);

  /* Then */
  assert.equal(r.event, null);
  assert.equal(r.draft.cursor, 2);
  assert.deepEqual(r.draft.picks[0], []);
});

test('a move that completes the set stays quiet', () => {
  /* When */
  const r = run([single], [{ kind: 'move', by: 1 }]);

  /* Then */
  assert.equal(r.event, null);
  assert.equal(answeredCount([single], r.draft), 1);
});

test('pressing an option picks it, says it was not the recommended one, and the cursor follows', () => {
  /* When */
  const r = run(qs, [{ kind: 'press', row: 2 }]);

  /* Then */
  assert.deepEqual(r.event, { kind: 'picked', recommended: false });
  assert.equal(r.draft.cursor, 2);
  assert.deepEqual(r.draft.picks[0], ['None']);
});

test('pressing the recommended option says so', () => {
  /* When */
  const r = run(qs, [{ kind: 'press', row: 1 }]);

  /* Then */
  assert.deepEqual(r.event, { kind: 'picked', recommended: true });
});

test('pressing the picked option again keeps it and says nothing', () => {
  /* Given */
  const picked = after(qs, [{ kind: 'press', row: 1 }, { kind: 'move', by: 1 }, { kind: 'move', by: 1 }, { kind: 'press', row: 2 }]);

  /* When */
  const r = run(qs, [{ kind: 'press', row: 2 }], picked);

  /* Then */
  assert.equal(r.event, null);
  assert.deepEqual(r.draft.picks[0], ['None']);
});

test('picking an option on a single-choice question replaces the last pick and clears Other', () => {
  /* Given */
  const picked = after(qs, [{ kind: 'type', text: 'mine' }, { kind: 'press', row: 0 }]);

  /* When */
  const r = run(qs, [{ kind: 'press', row: 2 }], picked);

  /* Then */
  assert.deepEqual(r.draft.picks[0], ['None']);
  assert.equal(r.draft.other[0], '');
});

test('pressing the Other row moves the cursor there and drops a single-choice pick', () => {
  /* Given */
  const picked = after(qs, [{ kind: 'press', row: 0 }]);

  /* When */
  const r = run(qs, [{ kind: 'press', row: 3 }], picked);

  /* Then */
  assert.equal(r.event, null);
  assert.equal(r.draft.cursor, 3);
  assert.deepEqual(r.draft.picks[0], []);
});

test('pressing the Other row on a multiple-choice question keeps the picks', () => {
  /* Given */
  const picked = after([multi], [{ kind: 'press', row: 0 }]);

  /* When */
  const r = run([multi], [{ kind: 'press', row: 3 }], picked);

  /* Then */
  assert.equal(r.draft.cursor, 3);
  assert.deepEqual(r.draft.picks[0], ['Logs']);
});

test('pressing a row that does not exist does nothing', () => {
  /* Given */
  const draft = createDraft(qs);

  for (const row of [-1, 4, 1.5]) {
    /* When */
    const r = reduceDraft(qs, draft, { kind: 'press', row });

    /* Then */
    assert.equal(r.draft, draft);
    assert.equal(r.event, null);
  }
});

test('a toggle on a multiple-choice question reports the count', () => {
  /* When */
  const r = run([multi, single], [{ kind: 'press', row: 2 }]);

  /* Then */
  assert.deepEqual(r.event, { kind: 'multi-count', count: 1, total: 3 });
});

test('toggles on a multiple-choice question count up and keep picks in option order', () => {
  /* Given */
  const one = after([multi, single], [{ kind: 'press', row: 2 }]);

  /* When */
  const r = run([multi, single], [{ kind: 'press', row: 0 }], one);

  /* Then */
  assert.deepEqual(r.event, { kind: 'multi-count', count: 2, total: 3 });
  assert.deepEqual(r.draft.picks[0], ['Logs', 'Traces']);
});

test('toggling a pick off on a multiple-choice question counts down', () => {
  /* Given */
  const two = after([multi, single], [{ kind: 'press', row: 2 }, { kind: 'press', row: 0 }]);

  /* When */
  const r = run([multi, single], [{ kind: 'press', row: 2 }], two);

  /* Then */
  assert.deepEqual(r.event, { kind: 'multi-count', count: 1, total: 3 });
  assert.deepEqual(r.draft.picks[0], ['Logs']);
  assert.equal(r.draft.cursor, 2);
});

test('the multi count leaves Other text out', () => {
  /* Given */
  const typed = after([multi, single], [{ kind: 'type', text: 'Profiles' }]);

  /* When */
  const r = run([multi, single], [{ kind: 'press', row: 1 }], typed);

  /* Then */
  assert.deepEqual(r.event, { kind: 'multi-count', count: 1, total: 3 });
  assert.equal(r.draft.other[0], 'Profiles', 'Other is one more thing to include, not a rival');
});

test('clicking the picked option of a single-choice question unpicks it', () => {
  /* Given */
  const picked = after(qs, [{ kind: 'click', row: 1 }]);

  /* When */
  const r = run(qs, [{ kind: 'click', row: 1 }], picked);

  /* Then */
  assert.deepEqual(r.event, { kind: 'unpicked' });
  assert.deepEqual(r.draft.picks[0], []);
  assert.equal(r.draft.cursor, 1);
});

test('clicking an unpicked option behaves like pressing', () => {
  /* When */
  const r = run(qs, [{ kind: 'click', row: 0 }]);

  /* Then */
  assert.deepEqual(r.event, { kind: 'picked', recommended: false });
});

test('clicking on a multiple-choice question behaves like pressing', () => {
  /* Given */
  const picked = after([multi, single], [{ kind: 'click', row: 0 }]);

  /* When */
  const r = run([multi, single], [{ kind: 'click', row: 0 }], picked);

  /* Then */
  assert.deepEqual(r.event, { kind: 'multi-count', count: 0, total: 3 });
});

test('space presses the row under the cursor', () => {
  /* Given */
  const moved = after([multi, single], [{ kind: 'move', by: 1 }]);

  /* When */
  const r = run([multi, single], [{ kind: 'space' }], moved);

  /* Then */
  assert.deepEqual(r.draft.picks[0], ['Metrics']);
  assert.deepEqual(r.event, { kind: 'multi-count', count: 1, total: 3 });
});

test('space does nothing on Other', () => {
  /* Given */
  const onOther = after([multi, single], [{ kind: 'move', by: -1 }]);

  /* When */
  const r = reduceDraft([multi, single], onOther, { kind: 'space' });

  /* Then */
  assert.equal(r.draft, onOther);
  assert.equal(r.event, null);
});

test('focusing Other is pressing its row', () => {
  /* Given */
  const picked = after(qs, [{ kind: 'press', row: 0 }]);

  /* When */
  const r = run(qs, [{ kind: 'focus-other' }], picked);

  /* Then */
  assert.equal(r.draft.cursor, 3);
  assert.deepEqual(r.draft.picks[0], []);
  assert.equal(r.event, null);
});

test('typing sets Other and drops a single-choice pick, but blank text announces nothing', () => {
  /* Given */
  const picked = after(qs, [{ kind: 'press', row: 0 }]);

  /* When */
  const r = run(qs, [{ kind: 'type', text: '   ' }], picked);

  /* Then */
  assert.equal(r.event, null, 'blank text is not an answer yet');
  assert.deepEqual(r.draft.picks[0], []);
  assert.equal(r.draft.cursor, 3);
});

test('typing announces the first non-blank text', () => {
  /* Given */
  const blank = after(qs, [{ kind: 'type', text: '   ' }]);

  /* When */
  const r = run(qs, [{ kind: 'type', text: ' 5m' }], blank);

  /* Then */
  assert.deepEqual(r.event, { kind: 'started-other' });
});

test('typing announces only the first non-blank text', () => {
  /* Given */
  const started = after(qs, [{ kind: 'type', text: '5' }]);

  /* When */
  const r = run(qs, [{ kind: 'type', text: '5m' }], started);

  /* Then */
  assert.equal(r.event, null);
  assert.equal(r.draft.other[0], '5m');
});

test('typing on a multiple-choice question keeps the picks', () => {
  /* Given */
  const picked = after([multi, single], [{ kind: 'press', row: 0 }]);

  /* When */
  const r = run([multi, single], [{ kind: 'type', text: 'Profiles' }], picked);

  /* Then */
  assert.deepEqual(r.draft.picks[0], ['Logs']);
  assert.equal(r.draft.cursor, 3);
});

test('isAnswered counts nothing on a fresh question', () => {
  /* Given */
  const draft = createDraft(qs);

  /* When */
  const answered = isAnswered(qs, draft, 0);

  /* Then */
  assert.equal(answered, false);
});

test('isAnswered does not count blank Other text', () => {
  /* Given */
  const draft = after(qs, [{ kind: 'type', text: '  ' }]);

  /* When */
  const answered = isAnswered(qs, draft, 0);

  /* Then */
  assert.equal(answered, false);
});

test('isAnswered counts non-blank Other text', () => {
  /* Given */
  const draft = after(qs, [{ kind: 'type', text: 'x' }]);

  /* When */
  const answered = isAnswered(qs, draft, 0);

  /* Then */
  assert.equal(answered, true);
});

test('isAnswered counts a pick', () => {
  /* Given */
  const draft = after(qs, [{ kind: 'press', row: 0 }]);

  /* When */
  const answered = isAnswered(qs, draft, 0);

  /* Then */
  assert.equal(answered, true);
});

test('isAnswered does not count a question that does not exist', () => {
  /* Given */
  const draft = after(qs, [{ kind: 'press', row: 0 }]);

  /* When */
  const answered = isAnswered(qs, draft, 7);

  /* Then */
  assert.equal(answered, false);
});

test('next is blocked until the current question is answered', () => {
  /* When */
  const r = run(qs, [{ kind: 'next' }]);

  /* Then */
  assert.deepEqual(r.event, { kind: 'blocked', isLast: false });
  assert.equal(r.draft.step, 0);
});

test('next advances with the answered count', () => {
  /* Given */
  const picked = after(qs, [{ kind: 'press', row: 0 }]);

  /* When */
  const r = run(qs, [{ kind: 'next' }], picked);

  /* Then */
  assert.deepEqual(r.event, { kind: 'advanced', done: 1, total: 3, isLast: false });
  assert.equal(r.draft.step, 1);
  assert.equal(r.draft.cursor, 0);
});

test('next says whether it landed on the last question', () => {
  /* Given */
  const secondPicked = after(qs, [{ kind: 'press', row: 0 }, { kind: 'next' }, { kind: 'press', row: 1 }]);

  /* When */
  const r = run(qs, [{ kind: 'next' }], secondPicked);

  /* Then */
  assert.deepEqual(r.event, { kind: 'advanced', done: 2, total: 3, isLast: true });
  assert.equal(r.draft.step, 2);
});

test('next on the last question submits when everything is answered, without touching the draft', () => {
  /* Given */
  const answered = after(qs, [
    { kind: 'press', row: 0 }, { kind: 'next' },
    { kind: 'press', row: 1 }, { kind: 'next' },
    { kind: 'press', row: 1 },
  ]);

  /* When */
  const r = reduceDraft(qs, answered, { kind: 'next' });

  /* Then */
  assert.deepEqual(r.event, { kind: 'submit' });
  assert.equal(r.draft, answered);
});

test('next on the last question is blocked while an earlier one is unanswered', () => {
  /* Given */
  const lastPicked = after(qs, [{ kind: 'goto', step: 2 }, { kind: 'press', row: 0 }]);

  /* When */
  const r = run(qs, [{ kind: 'next' }], lastPicked);

  /* Then */
  assert.deepEqual(r.event, { kind: 'blocked', isLast: true });
  assert.equal(r.draft.step, 2);
});

test('next on a blank last question is blocked', () => {
  /* Given */
  const onLast = after(qs, [{ kind: 'goto', step: 2 }]);

  /* When */
  const blank = run(qs, [{ kind: 'next' }], onLast);

  /* Then */
  assert.deepEqual(blank.event, { kind: 'blocked', isLast: true });
});

/** The first two questions answered, the third still open. */
const twoAnswered = () => after(qs, [{ kind: 'press', row: 0 }, { kind: 'next' }, { kind: 'press', row: 1 }, { kind: 'next' }]);

test('answering the last open question with a pick announces it instead of the usual event', () => {
  /* Given */
  const draft = twoAnswered();

  /* When */
  const r = run(qs, [{ kind: 'press', row: 0 }], draft);

  /* Then */
  assert.deepEqual(r.event, { kind: 'all-answered' });
});

test('answering the last open question with Other text announces it instead of the usual event', () => {
  /* Given */
  const draft = twoAnswered();

  /* When */
  const r = run(qs, [{ kind: 'type', text: 'Baz' }], draft);

  /* Then */
  assert.deepEqual(r.event, { kind: 'all-answered' });
});

test('the first toggle that answers a lone multiple-choice question announces it', () => {
  /* When */
  const r = run([multi], [{ kind: 'press', row: 0 }]);

  /* Then */
  assert.deepEqual(r.event, { kind: 'all-answered' });
});

test('a toggle once everything is already answered just reports the count', () => {
  /* Given */
  const answered = after([multi], [{ kind: 'press', row: 0 }]);

  /* When */
  const r = run([multi], [{ kind: 'press', row: 1 }], answered);

  /* Then */
  assert.deepEqual(r.event, { kind: 'multi-count', count: 2, total: 3 }, 'already all answered');
});

test('re-answering after unpicking announces everything again', () => {
  /* Given */
  const unpicked = after([single], [{ kind: 'click', row: 0 }, { kind: 'click', row: 0 }]);

  /* When */
  const r = run([single], [{ kind: 'click', row: 2 }], unpicked);

  /* Then */
  assert.deepEqual(r.event, { kind: 'all-answered' });
});

test('back goes to the previous question with the cursor on its pick', () => {
  /* Given */
  const advanced = after(qs, [{ kind: 'press', row: 2 }, { kind: 'next' }]);

  /* When */
  const r = run(qs, [{ kind: 'back' }], advanced);

  /* Then */
  assert.deepEqual(r.event, { kind: 'moved-to', header: 'Timeout' });
  assert.equal(r.draft.step, 0);
  assert.equal(r.draft.cursor, 2);
});

test('back on the first question does nothing', () => {
  /* Given */
  const draft = createDraft(qs);

  /* When */
  const r = reduceDraft(qs, draft, { kind: 'back' });

  /* Then */
  assert.equal(r.draft, draft);
  assert.equal(r.event, null);
});

test('landing on a question with only Other text puts the cursor on Other', () => {
  /* Given */
  const advanced = after(qs, [{ kind: 'type', text: 'Ten' }, { kind: 'next' }]);

  /* When */
  const r = run(qs, [{ kind: 'back' }], advanced);

  /* Then */
  assert.equal(r.draft.cursor, 3);
});

test('landing on a multiple-choice question with picks puts the cursor on the first row', () => {
  /* Given */
  const away = after(qs, [{ kind: 'goto', step: 1 }, { kind: 'press', row: 2 }, { kind: 'goto', step: 0 }]);

  /* When */
  const r = run(qs, [{ kind: 'goto', step: 1 }], away);

  /* Then */
  assert.equal(r.draft.cursor, 0);
});

test('goto jumps without the answered check, naming where it landed by number when it has no header', () => {
  /* When */
  const r = run(qs, [{ kind: 'goto', step: 2 }]);

  /* Then */
  assert.deepEqual(r.event, { kind: 'moved-to', header: 'Question 3' });
  assert.equal(r.draft.step, 2);
  assert.equal(r.draft.cursor, 0);
});

test('goto names where it landed by its header', () => {
  /* When */
  const r = run(qs, [{ kind: 'goto', step: 1 }]);

  /* Then */
  assert.deepEqual(r.event, { kind: 'moved-to', header: 'Features' });
});

test('goto the current or a missing question does nothing', () => {
  /* Given */
  const draft = createDraft(qs);

  for (const step of [0, -1, 3]) {
    /* When */
    const r = reduceDraft(qs, draft, { kind: 'goto', step });

    /* Then */
    assert.equal(r.draft, draft);
    assert.equal(r.event, null);
  }
});

test('draftAnswers keeps option order and the Recommended suffix, then trimmed Other text', () => {
  /* Given */
  const draft = after(qs, [
    { kind: 'press', row: 1 },
    { kind: 'goto', step: 1 }, { kind: 'press', row: 2 }, { kind: 'press', row: 0 }, { kind: 'type', text: '  Profiles  ' },
    { kind: 'goto', step: 2 }, { kind: 'type', text: ' Qux ' },
  ]);

  /* When */
  const answers = draftAnswers(qs, draft);

  /* Then */
  assert.deepEqual(answers, {
    'Timeout?': 'Long (Recommended)',
    'Features?': 'Logs, Traces, Profiles',
    'Name?': 'Qux',
  });
});

test('isRecommended reads Claude’s suffix loosely', () => {
  /* Given */
  const labels = ['Long (Recommended)', 'Long (recommended)  ', 'Long', '(Recommended) Long'];

  /* When */
  const recommended = labels.map(isRecommended);

  /* Then */
  assert.deepEqual(recommended, [true, true, false, false]);
});

test('displayLabel strips Claude’s suffix', () => {
  /* Given */
  const labels = ['Long (Recommended)', '  Long (RECOMMENDED) ', 'Long'];

  /* When */
  const shown = labels.map(displayLabel);

  /* Then */
  assert.deepEqual(shown, ['Long', 'Long', 'Long']);
});
