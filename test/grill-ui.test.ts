import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    commitField,
    fieldText,
    followQuestion,
    freshUi,
    normalisedTitle,
    reviseUi,
    sameAnswer,
    withInFlight,
} from '../src/renderer/features/grill/grill-ui';
import {question, view} from './support/grill-views';
import type {InFlightAnswer} from '../src/renderer/features/grill/grill-ui';

function inFlight(over: Partial<InFlightAnswer>): InFlightAnswer {
    return {seq: 1, roundId: 'r1', revision: 0, place: 0, answer: {kind: 'accepted'}, settled: false, ...over};
}

// ── Fields ──

test('a note answers with it, and an empty note is a plain accept', () => {
    /* When */
    const committed = [commitField({kind: 'note', text: '  flag it '}), commitField({kind: 'note', text: ' '})];

    /* Then */
    assert.deepEqual(committed, [
        {answer: {kind: 'noted', note: 'flag it'}, ask: null, advance: true},
        {answer: {kind: 'accepted'}, ask: null, advance: true},
    ]);
});

test('an answer of the user own answers when there is text, and only closes when there is none', () => {
    /* When */
    const committed = [commitField({kind: 'override', text: 'Use a table'}), commitField({kind: 'override', text: ''})];

    /* Then */
    assert.deepEqual(committed, [
        {answer: {kind: 'overridden', text: 'Use a table'}, ask: null, advance: true},
        {answer: null, ask: null, advance: false},
    ]);
});

test('an ask asks and stays on the question', () => {
    /* When */
    const committed = [commitField({kind: 'ask', text: ' why ten? '}), commitField({kind: 'ask', text: ''})];

    /* Then */
    assert.deepEqual(committed, [
        {answer: null, ask: 'why ten?', advance: false},
        {answer: null, ask: null, advance: false},
    ]);
});

test('a field opens on the answer it would edit', () => {
    /* Given */
    const noted = question(1, {answer: {kind: 'noted', note: 'flag it'}});
    const own = question(2, {answer: {kind: 'overridden', text: 'no'}});

    /* When */
    const texts = [
        fieldText(noted, 'note', undefined),
        fieldText(own, 'override', undefined),
        fieldText(own, 'note', undefined),
    ];

    /* Then */
    assert.deepEqual(texts, ['flag it', 'no', '']);
});

test('a field already open of the same kind keeps what was typed', () => {
    /* Given */
    const q = question(1, {answer: {kind: 'noted', note: 'old'}});

    /* When */
    const text = fieldText(q, 'note', {kind: 'note', text: 'half typed'});

    /* Then */
    assert.equal(text, 'half typed');
});

// ── Following questions through a revision ──

test('titles compare without case, punctuation or extra spaces', () => {
    /* When */
    const titles = [normalisedTitle('The **undo** window!'), normalisedTitle('the  undo   window')];

    /* Then */
    assert.deepEqual(titles, ['the undo window', 'the undo window']);
});

test('a question is followed by number and title, then by title alone', () => {
    /* Given */
    const before = [question(1, {title: 'Where'}), question(2, {title: 'How long'})];
    const after = [question(1, {title: 'How long'}), question(2, {title: 'Where'}), question(3, {title: 'Bulk'})];

    /* When */
    const places = [followQuestion(before, after, 0), followQuestion(before, after, 1)];

    /* Then */
    assert.deepEqual(places, [1, 0]);
});

test('a question with a reused number and another title is not followed', () => {
    /* Given */
    const before = [question(1, {title: 'Where'})];
    const after = [question(1, {title: 'Something else'})];

    /* When */
    const place = followQuestion(before, after, 0);

    /* Then */
    assert.equal(place, null);
});

test('after a revision the place follows its question, and open fields theirs', () => {
    /* Given */
    const before = [question(1, {title: 'A'}), question(2, {title: 'B'}), question(3, {title: 'C'})];
    const after = [question(1, {title: 'C'}), question(2, {title: 'A'})];
    const ui = {
        ...freshUi('r1', 0),
        place: 2,
        fields: {0: {kind: 'note' as const, text: 'on A'}, 1: {kind: 'ask' as const, text: 'on B'}},
    };

    /* When */
    const revised = reviseUi(ui, before, after);

    /* Then */
    assert.equal(revised.place, 0);
    assert.deepEqual(revised.fields, {1: {kind: 'note', text: 'on A'}});
});

test('a place whose question was dropped stays as near as the new round allows', () => {
    /* Given */
    const before = [question(1, {title: 'A'}), question(2, {title: 'B'}), question(3, {title: 'C'})];
    const after = [question(1, {title: 'A'})];
    const ui = {...freshUi('r1', 0), place: 2};

    /* When */
    const revised = reviseUi(ui, before, after);

    /* Then */
    assert.equal(revised.place, 0);
});

test('the review stays the review after a revision', () => {
    /* Given */
    const before = [question(1), question(2)];
    const after = [question(1), question(2), question(3)];
    const ui = {...freshUi('r1', 0), place: 2};

    /* When */
    const revised = reviseUi(ui, before, after);

    /* Then */
    assert.equal(revised.place, 3);
});

// ── Answers in flight ──

test('an answer in flight shows over main view until it settles', () => {
    /* Given */
    const v = view(2);

    /* When */
    const shown = withInFlight(v, [inFlight({place: 1, answer: {kind: 'noted', note: 'x'}})]);

    /* Then */
    assert.deepEqual(shown.questions[1]!.answer, {kind: 'noted', note: 'x'});
    assert.equal(shown.questions[0]!.answer, null);
});

test('a cleared answer in flight shows as cleared', () => {
    /* Given */
    const v = view(1);
    v.questions[0] = question(1, {answer: {kind: 'accepted'}});

    /* When */
    const shown = withInFlight(v, [inFlight({answer: null})]);

    /* Then */
    assert.equal(shown.questions[0]!.answer, null);
});

test('the latest call for a place wins', () => {
    /* Given */
    const v = view(1);

    /* When */
    const shown = withInFlight(v, [
        inFlight({seq: 3, answer: {kind: 'overridden', text: 'late'}}),
        inFlight({seq: 2, answer: {kind: 'accepted'}}),
    ]);

    /* Then */
    assert.deepEqual(shown.questions[0]!.answer, {kind: 'overridden', text: 'late'});
});

test('an answer given against another revision or round is not laid over', () => {
    /* Given */
    const v = view(1, {revision: 1});

    /* When */
    const shown = withInFlight(v, [inFlight({revision: 0}), inFlight({revision: 1, roundId: 'r0'})]);

    /* Then */
    assert.strictEqual(shown, v);
});

test('answers compare by kind and words', () => {
    /* When */
    const same = [
        sameAnswer({kind: 'accepted'}, {kind: 'accepted'}),
        sameAnswer({kind: 'noted', note: 'a'}, {kind: 'noted', note: 'a'}),
        sameAnswer({kind: 'noted', note: 'a'}, {kind: 'noted', note: 'b'}),
        sameAnswer(null, {kind: 'accepted'}),
        sameAnswer(null, null),
    ];

    /* Then */
    assert.deepEqual(same, [true, true, false, false, true]);
});
