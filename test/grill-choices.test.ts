import {test} from 'node:test';
import assert from 'node:assert/strict';

import {recommendedLetter, splitChoices} from '../src/domain/grill/choices';
import type {Choices} from '../src/domain/grill/model';

/**
 * The lettered choices a grilling question's reason offers inline, and the
 * one its recommendation picks.
 */

const letters = (choices: Choices | undefined) => choices?.list.map((c) => [c.letter, c.text]);

test('parenthesised choices split the reason into lead, choices and what follows their sentence', () => {
    /* Given */
    const reason = 'Logs grow fast. (a) Keep a week; (b) Keep a month; (c) Keep them all. Disk is cheap, though.';

    /* When */
    const choices = splitChoices(reason);

    /* Then */
    assert.deepEqual(choices, {
        lead: 'Logs grow fast.',
        list: [
            {letter: 'a', text: 'Keep a week'},
            {letter: 'b', text: 'Keep a month'},
            {letter: 'c', text: 'Keep them all'},
        ],
        after: 'Disk is cheap, though.',
    });
});

test('half-parenthesised choices joined by commas and "or" are choices too', () => {
    /* Given */
    const reason = 'Pick a default: a) light, b) dark, or c) follow the system.';

    /* When */
    const choices = splitChoices(reason);

    /* Then */
    assert.equal(choices?.lead, 'Pick a default:');
    assert.deepEqual(letters(choices), [
        ['a', 'light'],
        ['b', 'dark'],
        ['c', 'follow the system'],
    ]);
    assert.equal(choices?.after, '');
});

test('a Dutch "of" between choices is dropped like "or"', () => {
    /* Given */
    const reason = '(a) per dag of (b) per week.';

    /* When */
    const choices = splitChoices(reason);

    /* Then */
    assert.deepEqual(letters(choices), [
        ['a', 'per dag'],
        ['b', 'per week'],
    ]);
});

test('bold markers are read as choices', () => {
    /* Given */
    const reason = 'Either **(a)** inline or **(b)** a modal.';

    /* When */
    const choices = splitChoices(reason);

    /* Then */
    assert.deepEqual(letters(choices), [
        ['a', 'inline'],
        ['b', 'a modal'],
    ]);
});

test('a last choice ending in a question mark keeps it', () => {
    /* Given */
    const reason = '(a) Now, or (b) after the release? Both work.';

    /* When */
    const choices = splitChoices(reason);

    /* Then */
    assert.deepEqual(letters(choices), [
        ['a', 'Now'],
        ['b', 'after the release?'],
    ]);
    assert.equal(choices?.after, 'Both work.');
});

test('a last choice ends at the line’s end when its sentence has no stop', () => {
    /* Given */
    const reason = 'Choose: (a) tabs (b) spaces\nThe linter takes either.';

    /* When */
    const choices = splitChoices(reason);

    /* Then */
    assert.deepEqual(letters(choices), [
        ['a', 'tabs'],
        ['b', 'spaces'],
    ]);
    assert.equal(choices?.after, 'The linter takes either.');
});

test('a single lettered option is no set of choices', () => {
    /* When */
    const choices = splitChoices('We could (a) keep it as it is.');

    /* Then */
    assert.equal(choices, undefined);
});

test('choices must be lettered from a, in order', () => {
    /* When */
    const parsed = [splitChoices('(b) one; (c) two.'), splitChoices('(a) one; (c) two.')];

    /* Then */
    assert.deepEqual(parsed, [undefined, undefined]);
});

test('a Markdown list of lettered items stays text', () => {
    /* Given */
    const reasons = [
        'Pick one:\n\n- (a) Postgres\n- (b) Redis',
        'Pick one:\n(a) Postgres\n(b) Redis',
        'Pick one:\n1. a) Postgres\n2. b) Redis',
    ];

    /* When */
    const parsed = reasons.map(splitChoices);

    /* Then */
    assert.deepEqual(parsed, [undefined, undefined, undefined]);
});

test('choices in separate paragraphs are not a run', () => {
    /* When */
    const choices = splitChoices('First (a) this one.\n\nThen (b) that one.');

    /* Then */
    assert.equal(choices, undefined);
});

test('a letter with a parenthesis inside a word is not a marker', () => {
    /* When */
    const choices = splitChoices('Call f(a) and g(b) in that order.');

    /* Then */
    assert.equal(choices, undefined);
});

// ── The recommended choice ──

const CHOICES: Choices = {
    lead: '',
    list: [
        {letter: 'a', text: 'one'},
        {letter: 'b', text: 'two'},
    ],
    after: '',
};

test('the recommendation names its choice by the letter it opens with, in any marker shape', () => {
    /* Given */
    const recommendations = ['(a) One, since…', 'a) One.', '(b). Two.', '**b)** Two.', '**(b)** Two.', '(b)'];

    /* When */
    const picked = recommendations.map((r) => recommendedLetter(r, CHOICES));

    /* Then */
    assert.deepEqual(picked, ['a', 'a', 'b', 'b', 'b', 'b']);
});

test('a recommendation opening with anything else, or a letter not offered, names no choice', () => {
    /* Given */
    const recommendations = ['Two, because (b) is simpler.', '(c) Neither.', 'Both are fine.', 'a lot of reasons'];

    /* When */
    const picked = recommendations.map((r) => recommendedLetter(r, CHOICES));

    /* Then */
    assert.deepEqual(picked, [undefined, undefined, undefined, undefined]);
});
