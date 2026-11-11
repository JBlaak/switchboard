import {test} from 'node:test';
import assert from 'node:assert/strict';

import {answerText, answersPrompt, askPrompt, askedQuestionLabel, waitWhatPrompt} from '../src/domain/grill/reply';

/**
 * What Switchboard types into a grilling session: the answers to a round,
 * and the asks about one of its questions, which it must recognise again.
 */

test('each answered question gets a line in the round’s own numbering', () => {
    /* Given */
    const questions = [
        {number: 1, answer: {kind: 'accepted' as const}},
        {number: 3, answer: {kind: 'noted' as const, note: 'keep it behind a flag'}},
        {number: 4, answer: {kind: 'overridden' as const, text: '(b) 30 days, then drop the row'}},
    ];

    /* When */
    const prompt = answersPrompt(questions);

    /* Then */
    assert.equal(prompt, 'Q1: yes\nQ3: yes, note: keep it behind a flag\nQ4: (b) 30 days, then drop the row');
});

test('a question whose number the round split by a letter goes back under its letter', () => {
    /* Given */
    const questions = [
        {number: 2, suffix: 'a', answer: {kind: 'accepted' as const}},
        {number: 2, suffix: 'b', answer: {kind: 'overridden' as const, text: 'No'}},
        {number: 3, answer: {kind: 'accepted' as const}},
    ];

    /* When */
    const prompt = answersPrompt(questions);

    /* Then */
    assert.equal(prompt, 'Q2a: yes\nQ2b: No\nQ3: yes');
});

test('a question without an answer is left out', () => {
    /* Given */
    const questions = [
        {number: 1, answer: null},
        {number: 2, answer: {kind: 'accepted' as const}},
    ];

    /* When */
    const prompt = answersPrompt(questions);

    /* Then */
    assert.equal(prompt, 'Q2: yes');
});

test('nothing answered is an empty prompt', () => {
    /* When */
    const prompt = answersPrompt([{number: 1, answer: null}]);

    /* Then */
    assert.equal(prompt, '');
});

test('an answer running over several lines is collapsed onto its own', () => {
    /* When */
    const texts = [
        answerText({kind: 'noted', note: '  first\n\nsecond  '}),
        answerText({kind: 'overridden', text: 'Not now.\n- later\n'}),
    ];

    /* Then */
    assert.deepEqual(texts, ['yes, note: first second', 'Not now. - later']);
});

test('an ask names its question and carries what the user typed on one line', () => {
    /* When */
    const prompt = askPrompt(3, 'Why not\nboth?');

    /* Then */
    assert.equal(prompt, 'Before I answer the round, about Q3: Why not both?');
});

test('wait, what? asks for a re-pitch of one question', () => {
    /* When */
    const prompt = waitWhatPrompt(2);

    /* Then */
    assert.equal(prompt, '/wait-what Q2');
});

test('Switchboard’s own asks are recognised by the question they name', () => {
    /* When */
    const numbers = [askedQuestionLabel(askPrompt(12, 'what does this cost?')), askedQuestionLabel(waitWhatPrompt(4))];

    /* Then */
    assert.deepEqual(numbers, ['12', '4']);
});

test('an ask about a lettered question is recognised by its label', () => {
    /* When */
    const labels = [askedQuestionLabel(askPrompt('2a', 'why?')), askedQuestionLabel(waitWhatPrompt('2b'))];

    /* Then */
    assert.deepEqual(labels, ['2a', '2b']);
});

test('an ask comes back recognised with the whitespace the hook adds around it', () => {
    /* When */
    const numbers = [askedQuestionLabel(`\n${askPrompt(1, 'why?')}\n`), askedQuestionLabel(` ${waitWhatPrompt(5)} `)];

    /* Then */
    assert.deepEqual(numbers, ['1', '5']);
});

test('an ask with nothing typed is still recognised', () => {
    /* When */
    const number = askedQuestionLabel(askPrompt(3, '  '));

    /* Then */
    assert.equal(number, '3');
});

test('any other prompt is no ask', () => {
    /* When */
    const numbers = [
        askedQuestionLabel('Q1: yes\nQ2: yes'),
        askedQuestionLabel('/wait-what Q2 Q3'),
        askedQuestionLabel('/wait-what'),
        askedQuestionLabel('about Q3: why?'),
        askedQuestionLabel('Before I answer the round, about Q: why?'),
    ];

    /* Then */
    assert.deepEqual(numbers, [null, null, null, null, null]);
});
