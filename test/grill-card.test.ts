import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    acceptRest,
    answerLabel,
    answeredCount,
    choiceAnswer,
    onReview,
    pickedChoice,
    questionCounter,
    reviewFlag,
    reviewPreview,
    revisionNote,
    sendGroup,
    stepPlace,
    tabState,
} from '../src/renderer/features/grill/grill-card';
import {choiceQuestion, question, view} from './support/grill-views';

// ── Tabs ──

test('a question nobody touched has an open tab', () => {
    /* Given */
    const q = question(1);

    /* When */
    const tab = tabState(q);

    /* Then */
    assert.deepEqual(tab, {state: 'open', mark: null});
});

test('a tab takes the kind of its answer', () => {
    /* Given */
    const qs = [
        question(1, {answer: {kind: 'accepted'}}),
        question(2, {answer: {kind: 'noted', note: 'flag it'}}),
        question(3, {answer: {kind: 'overridden', text: 'no'}}),
    ];

    /* When */
    const states = qs.map((q) => tabState(q).state);

    /* Then */
    assert.deepEqual(states, ['accepted', 'noted', 'overridden']);
});

test('a question asked about and not yet answered shows as asked', () => {
    /* Given */
    const q = question(1, {asked: true});

    /* When */
    const tab = tabState(q);

    /* Then */
    assert.equal(tab.state, 'asked');
});

test('an answer wins over having asked about the question', () => {
    /* Given */
    const q = question(1, {asked: true, answer: {kind: 'accepted'}});

    /* When */
    const tab = tabState(q);

    /* Then */
    assert.equal(tab.state, 'accepted');
});

test('a tab carries the mark a revision left on its question', () => {
    /* Given */
    const qs = [question(1, {mark: 'changed'}), question(2, {mark: 'new'})];

    /* When */
    const marks = qs.map((q) => tabState(q).mark);

    /* Then */
    assert.deepEqual(marks, ['changed', 'new']);
});

// ── Answers in words ──

test('an answer reads as accepted, accepted with its note, or the user own answer', () => {
    /* Given */
    const answers = [
        null,
        {kind: 'accepted'} as const,
        {kind: 'noted', note: 'behind a flag'} as const,
        {kind: 'overridden', text: 'Use a table'} as const,
    ];

    /* When */
    const labels = answers.map(answerLabel);

    /* Then */
    assert.deepEqual(labels, [
        'Not answered',
        'Accepted',
        'Accepted, note: behind a flag',
        'Your answer: Use a table',
    ]);
});

test('answered counts only questions with a draft answer, not a set-aside one', () => {
    /* Given */
    const v = view(3);
    v.questions[0] = question(1, {answer: {kind: 'accepted'}});
    v.questions[1] = question(2, {setAside: {kind: 'accepted'}, mark: 'changed'});

    /* When */
    const count = answeredCount(v);

    /* Then */
    assert.equal(count, 1);
});

// ── Choices ──

test('picking the recommended choice accepts the recommendation', () => {
    /* Given */
    const q = choiceQuestion(2, 'c');

    /* When */
    const answer = choiceAnswer(q, 'c');

    /* Then */
    assert.deepEqual(answer, {kind: 'accepted'});
});

test('picking another choice answers instead with the choice spelled out', () => {
    /* Given */
    const q = choiceQuestion(2, 'c');

    /* When */
    const answer = choiceAnswer(q, 'b');

    /* Then */
    assert.deepEqual(answer, {kind: 'overridden', text: '(b) 30 days'});
});

test('a letter the question does not offer answers nothing', () => {
    /* Given */
    const q = choiceQuestion(2);

    /* When */
    const answer = choiceAnswer(q, 'f');

    /* Then */
    assert.equal(answer, null);
});

test('the picked choice is the recommended one once accepted', () => {
    /* Given */
    const q = {...choiceQuestion(2, 'c'), answer: {kind: 'noted', note: 'ok'} as const};

    /* When */
    const picked = pickedChoice(q);

    /* Then */
    assert.equal(picked, 'c');
});

test('the picked choice is the one an answer of the user own opens with', () => {
    /* Given */
    const q = {...choiceQuestion(2, 'c'), answer: {kind: 'overridden', text: '(a) Forever'} as const};

    /* When */
    const picked = pickedChoice(q);

    /* Then */
    assert.equal(picked, 'a');
});

test('no choice is picked for an answer in the user own words, or none at all', () => {
    /* Given */
    const own = {...choiceQuestion(2), answer: {kind: 'overridden', text: 'Something else'} as const};
    const open = choiceQuestion(2);

    /* When */
    const picked = [pickedChoice(own), pickedChoice(open)];

    /* Then */
    assert.deepEqual(picked, [null, null]);
});

// ── Accept the rest ──

test('accept the rest accepts every unanswered question, set-aside ones included', () => {
    /* Given */
    const v = view(4);
    v.questions[0] = question(1, {answer: {kind: 'overridden', text: 'no'}});
    v.questions[2] = question(3, {setAside: {kind: 'accepted'}, mark: 'changed'});

    /* When */
    const calls = acceptRest(v);

    /* Then */
    assert.deepEqual(calls, [
        {place: 1, answer: {kind: 'accepted'}},
        {place: 2, answer: {kind: 'accepted'}},
        {place: 3, answer: {kind: 'accepted'}},
    ]);
});

test('accept the rest has nothing to do once everything is answered', () => {
    /* Given */
    const v = view(1);
    v.questions[0] = question(1, {answer: {kind: 'accepted'}});

    /* When */
    const calls = acceptRest(v);

    /* Then */
    assert.deepEqual(calls, []);
});

// ── Review ──

test('the preview is the prompt Claude will receive, leaving out set-aside answers', () => {
    /* Given */
    const v = view(4);
    v.questions[0] = question(1, {answer: {kind: 'accepted'}});
    v.questions[1] = question(2, {answer: {kind: 'noted', note: 'keep it\nshort'}});
    v.questions[2] = question(3, {setAside: {kind: 'accepted'}, mark: 'changed'});
    v.questions[3] = question(7, {answer: {kind: 'overridden', text: '(b) 30 days'}});

    /* When */
    const preview = reviewPreview(v);

    /* Then */
    assert.equal(preview, 'Q1: yes\nQ2: yes, note: keep it short\nQ7: (b) 30 days');
});

test('the preview is empty while nothing is answered', () => {
    /* Given */
    const v = view(2);

    /* When */
    const preview = reviewPreview(v);

    /* Then */
    assert.equal(preview, '');
});

test('the review flags new and changed questions, and a set-aside answer', () => {
    /* Given */
    const qs = [
        question(1),
        question(2, {mark: 'new'}),
        question(3, {mark: 'changed'}),
        question(4, {mark: 'changed', setAside: {kind: 'accepted'}}),
    ];

    /* When */
    const flags = qs.map(reviewFlag);

    /* Then */
    assert.deepEqual(flags, ['', 'New', 'Changed', 'Changed, earlier answer set aside']);
});

test('the note under a title says what the revision did', () => {
    /* Given */
    const qs = [
        question(1),
        question(2, {mark: 'new'}),
        question(3, {mark: 'changed'}),
        question(4, {mark: 'changed', setAside: {kind: 'accepted'}}),
    ];

    /* When */
    const notes = qs.map(revisionNote);

    /* Then */
    assert.deepEqual(notes, [
        null,
        'Claude added this question.',
        'Claude changed this question.',
        'Claude changed this question since you answered it.',
    ]);
});

test('the counter names the question by its own number and its place in the round', () => {
    /* Given */
    const v = view(0, {questions: [question(1), question(3), question(7)]});

    /* When */
    const counter = questionCounter(v, 1);

    /* Then */
    assert.equal(counter, 'Question 3 · 2 of 3');
});

// ── Moving ──

test('down past the last question lands on the review, and no further', () => {
    /* Given */
    const v = view(2);

    /* When */
    const places = [stepPlace(v, 1, 1), stepPlace(v, 2, 1)];

    /* Then */
    assert.deepEqual(places, [2, 2]);
    assert.equal(onReview(v, 2), true);
});

test('up stops at the first question', () => {
    /* Given */
    const v = view(2);

    /* When */
    const place = stepPlace(v, 0, -1);

    /* Then */
    assert.equal(place, 0);
});

// ── Sending ──

test('with agents running the card offers to send when research is done', () => {
    /* Given */
    const v = view(1, {agentsRunning: 2});

    /* When */
    const group = sendGroup(v);

    /* Then */
    assert.equal(group, 'research');
});

test('with nothing running the card offers a plain send', () => {
    /* Given */
    const v = view(1);

    /* When */
    const group = sendGroup(v);

    /* Then */
    assert.equal(group, 'send');
});

test('a queued send shows as queued, whether or not agents still run', () => {
    /* Given */
    const views = [view(1, {send: 'queued', agentsRunning: 1}), view(1, {send: 'queued'})];

    /* When */
    const groups = views.map(sendGroup);

    /* Then */
    assert.deepEqual(groups, ['queued', 'queued']);
});
