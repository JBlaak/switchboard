import {test} from 'node:test';
import assert from 'node:assert/strict';
import {neighbourOpenSession, stepOpenSession} from '../src/renderer/state/list-cursor';

/** The sidebar's row order; every one of them open unless `ended` says otherwise. */
const ORDER = ['a', 'b', 'c', 'd'];
const openExcept =
    (...ended: string[]) =>
    (id: string) =>
        !ended.includes(id);
const allOpen = openExcept();

test('the next session is the next open one in sidebar order', () => {
    /* When */
    const next = stepOpenSession(ORDER, allOpen, 'b', 1);

    /* Then */
    assert.equal(next, 'c');
});

test('stepping wraps round at both ends', () => {
    /* When */
    const pastTheEnd = stepOpenSession(ORDER, allOpen, 'd', 1);
    const beforeTheStart = stepOpenSession(ORDER, allOpen, 'a', -1);

    /* Then */
    assert.equal(pastTheEnd, 'a');
    assert.equal(beforeTheStart, 'd');
});

test('rows with no open session are not stepped onto', () => {
    /* Given */
    const isOpen = (id: string) => id === 'a' || id === 'c';

    /* When */
    const next = stepOpenSession(ORDER, isOpen, 'a', 1);

    /* Then */
    assert.equal(next, 'c');
});

test('a session whose process has ended is skipped', () => {
    /* When */
    const next = stepOpenSession(ORDER, openExcept('c'), 'b', 1);

    /* Then */
    assert.equal(next, 'd');
});

test('with no session on screen, it goes to the first open one, either way', () => {
    /* When */
    const forward = stepOpenSession(ORDER, openExcept('a'), null, 1);
    const back = stepOpenSession(ORDER, openExcept('a'), null, -1);

    /* Then */
    assert.equal(forward, 'b');
    assert.equal(back, 'b');
});

test('a session on screen that is not open counts as none', () => {
    /* When */
    const next = stepOpenSession(ORDER, openExcept('b'), 'b', 1);

    /* Then */
    assert.equal(next, 'a');
});

test('with nothing open there is nowhere to go', () => {
    /* When */
    const next = stepOpenSession(ORDER, () => false, 'a', 1);

    /* Then */
    assert.equal(next, null);
});

// ── The neighbour a swipe on the pane goes to (#377) ──

test('a swipe goes to the neighbour in the order the keys step through', () => {
    /* Given */
    const current = 'b';

    /* When */
    const next = neighbourOpenSession(ORDER, allOpen, current, 1);
    const previous = neighbourOpenSession(ORDER, allOpen, current, -1);

    /* Then */
    assert.equal(next, stepOpenSession(ORDER, allOpen, current, 1));
    assert.equal(previous, stepOpenSession(ORDER, allOpen, current, -1));
    assert.equal(next, 'c');
    assert.equal(previous, 'a');
});

test('a swipe does not wrap round: past either end there is nothing', () => {
    /* Given */
    const first = 'a';
    const last = 'd';

    /* When */
    const pastTheEnd = neighbourOpenSession(ORDER, allOpen, last, 1);
    const beforeTheStart = neighbourOpenSession(ORDER, allOpen, first, -1);

    /* Then */
    assert.equal(pastTheEnd, null);
    assert.equal(beforeTheStart, null);
});

test('the ends are the ends of the open sessions, not of the rows', () => {
    /* Given: only b and c are open */
    const isOpen = (id: string) => id === 'b' || id === 'c';

    /* When */
    const pastTheEnd = neighbourOpenSession(ORDER, isOpen, 'c', 1);
    const beforeTheStart = neighbourOpenSession(ORDER, isOpen, 'b', -1);
    const across = neighbourOpenSession(ORDER, isOpen, 'b', 1);

    /* Then */
    assert.equal(pastTheEnd, null);
    assert.equal(beforeTheStart, null);
    assert.equal(across, 'c');
});

test('a swipe skips a session whose process has ended', () => {
    /* Given */
    const isOpen = openExcept('c');

    /* When */
    const next = neighbourOpenSession(ORDER, isOpen, 'b', 1);

    /* Then */
    assert.equal(next, 'd');
});

test('with one open session there is nowhere to swipe to', () => {
    /* Given */
    const isOpen = (id: string) => id === 'b';

    /* When */
    const next = neighbourOpenSession(ORDER, isOpen, 'b', 1);
    const previous = neighbourOpenSession(ORDER, isOpen, 'b', -1);

    /* Then */
    assert.equal(next, null);
    assert.equal(previous, null);
});

test('with no open session on screen, a swipe goes nowhere', () => {
    /* Given */
    const isOpen = openExcept('b');

    /* When */
    const fromNothing = neighbourOpenSession(ORDER, allOpen, null, 1);
    const fromEnded = neighbourOpenSession(ORDER, isOpen, 'b', 1);

    /* Then */
    assert.equal(fromNothing, null);
    assert.equal(fromEnded, null);
});
