import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grillKey} from '../src/renderer/features/grill/grill-keys';
import type {GrillKey, GrillKeyEvent, GrillKeyPlace} from '../src/renderer/features/grill/grill-keys';

/** A key on a question with three choices, on the card itself unless `at` says otherwise. */
function press(key: string, at: Partial<GrillKeyPlace> = {}, mods: Partial<GrillKeyEvent> = {}): GrillKey {
    return grillKey(
        {key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods},
        {inField: false, onReview: false, choices: 3, peeking: false, ...at},
    );
}

test('the answering keys act on the question', () => {
    /* When */
    const pressed = ['y', 'n', 'o', '?', 'w', 'a', 'ArrowDown', 'ArrowUp'].map((key) => press(key));

    /* Then */
    assert.deepEqual(
        pressed.map((k) => (k.does === 'act' ? k.action : k.does)),
        ['accept', 'note', 'override', 'ask', 'wait', 'rest', 'next', 'prev'],
    );
});

test('capital letters act as their lower-case keys', () => {
    /* When */
    const pressed = press('Y', {}, {shiftKey: true});

    /* Then */
    assert.deepEqual(pressed, {does: 'act', action: 'accept'});
});

test('T and Esc look at the terminal', () => {
    /* When */
    const pressed = [press('t'), press('Escape')];

    /* Then */
    assert.deepEqual(pressed, [
        {does: 'act', action: 'peek'},
        {does: 'act', action: 'peek'},
    ]);
});

test('while the terminal shows, T or Esc comes back and nothing else acts', () => {
    /* When */
    const pressed = [press('T', {peeking: true}), press('Escape', {peeking: true}), press('y', {peeking: true})];

    /* Then */
    assert.deepEqual(pressed, [{does: 'act', action: 'unpeek'}, {does: 'act', action: 'unpeek'}, {does: 'keep'}]);
});

test('a number picks the question inline choice', () => {
    /* When */
    const pressed = press('2');

    /* Then */
    assert.deepEqual(pressed, {does: 'choice', index: 1});
});

test('a number past the question choices does nothing', () => {
    /* When */
    const pressed = [press('4'), press('1', {choices: 0})];

    /* Then */
    assert.deepEqual(pressed, [{does: 'keep'}, {does: 'keep'}]);
});

test('on the review only accept the rest, moving and the terminal act', () => {
    /* When */
    const pressed = ['y', 'n', 'o', '?', 'w', '1', 'a', 'ArrowUp', 't'].map((key) => press(key, {onReview: true}));

    /* Then */
    assert.deepEqual(pressed, [
        {does: 'keep'},
        {does: 'keep'},
        {does: 'keep'},
        {does: 'keep'},
        {does: 'keep'},
        {does: 'keep'},
        {does: 'act', action: 'rest'},
        {does: 'act', action: 'prev'},
        {does: 'act', action: 'peek'},
    ]);
});

test('Cmd+Enter and Ctrl+Enter send, from the card and from a field', () => {
    /* When */
    const pressed = [
        press('Enter', {}, {metaKey: true}),
        press('Enter', {inField: true}, {metaKey: true}),
        press('Enter', {onReview: true}, {ctrlKey: true}),
    ];

    /* Then */
    assert.deepEqual(pressed, [
        {does: 'act', action: 'send'},
        {does: 'act', action: 'send'},
        {does: 'act', action: 'send'},
    ]);
});

test('in a field, Enter goes on, Shift+Enter is a newline and Esc closes it', () => {
    /* When */
    const pressed = [
        press('Enter', {inField: true}),
        press('Enter', {inField: true}, {shiftKey: true}),
        press('Escape', {inField: true}),
    ];

    /* Then */
    assert.deepEqual(pressed, [{does: 'act', action: 'commit'}, {does: 'keep'}, {does: 'act', action: 'close-field'}]);
});

test('in a field, the answering keys are only typing', () => {
    /* When */
    const pressed = ['y', 'a', '2', 't', 'ArrowDown'].map((key) => press(key, {inField: true}));

    /* Then */
    assert.deepEqual(pressed, Array(5).fill({does: 'keep'}));
});

test('left and right step through the round like up and down', () => {
    /* When */
    const onQuestion = ['ArrowRight', 'ArrowLeft'].map((key) => press(key));
    const onReview = press('ArrowLeft', {onReview: true});
    const inField = press('ArrowLeft', {inField: true});

    /* Then */
    assert.deepEqual(onQuestion, [
        {does: 'act', action: 'next'},
        {does: 'act', action: 'prev'},
    ]);
    assert.deepEqual(onReview, {does: 'act', action: 'prev'});
    assert.deepEqual(inField, {does: 'keep'});
});

test('other modified keys, Tab and IME composition go on to the app', () => {
    /* When */
    const pressed = [
        press('k', {}, {metaKey: true}),
        press('y', {}, {altKey: true}),
        press('Tab'),
        press('y', {}, {isComposing: true}),
        press('Enter', {inField: true}, {isComposing: true, metaKey: true}),
    ];

    /* Then */
    assert.deepEqual(pressed, Array(5).fill({does: 'pass'}));
});

test('unmodified keys that mean nothing stop at the card', () => {
    /* When */
    const pressed = ['x', 'Enter', 'Backspace'].map((key) => press(key));

    /* Then */
    assert.deepEqual(pressed, Array(3).fill({does: 'keep'}));
});
