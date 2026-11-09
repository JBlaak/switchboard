/**
 * The order of the pinned sections (`domain/pin/pin-order`, #379): moving a
 * pin or a group's pins, a new pin at the end, unpinning, and the order of
 * pins stored before positions existed.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    appendPin,
    comparePinPositions,
    moveBlock,
    orderPins,
    pinKey,
    pinSection,
    withoutPin,
} from '../src/domain/pin/pin-order';
import type {PinRef} from '../src/domain/pin/pin-order';

const same = (pin: string): string => pin;

test('a pin moved before another lands right above it', () => {
    /* Given */
    const order = ['a', 'b', 'c', 'd'];

    /* When */
    const moved = moveBlock(order, ['d'], {before: 'b'}, same);

    /* Then */
    assert.deepEqual(moved, ['a', 'd', 'b', 'c']);
});

test('a pin moved after another lands right below it', () => {
    /* Given */
    const order = ['a', 'b', 'c', 'd'];

    /* When */
    const moved = moveBlock(order, ['a'], {after: 'c'}, same);

    /* Then */
    assert.deepEqual(moved, ['b', 'c', 'a', 'd']);
});

test('a pin moved after the last one goes to the end', () => {
    /* Given */
    const order = ['a', 'b', 'c'];

    /* When */
    const moved = moveBlock(order, ['a'], {after: 'c'}, same);

    /* Then */
    assert.deepEqual(moved, ['b', 'c', 'a']);
});

test("a group's pins move together and keep their own order, even when apart", () => {
    /* Given */
    const order = ['g1', 'a', 'g2', 'b', 'c'];

    /* When */
    const moved = moveBlock(order, ['g2', 'g1'], {after: 'b'}, same);

    /* Then */
    assert.deepEqual(moved, ['a', 'b', 'g1', 'g2', 'c']);
});

test('pins the list does not show keep their places around a move', () => {
    /* Given: h is pinned but not on screen (archived, or live in another section) */
    const order = ['a', 'h', 'b', 'c'];

    /* When */
    const moved = moveBlock(order, ['c'], {before: 'b'}, same);

    /* Then */
    assert.deepEqual(moved, ['a', 'h', 'c', 'b']);
});

test('a move next to a pin that is gone leaves the order alone', () => {
    /* Given */
    const order = ['a', 'b', 'c'];

    /* When */
    const moved = moveBlock(order, ['a'], {before: 'gone'}, same);

    /* Then */
    assert.deepEqual(moved, ['a', 'b', 'c']);
});

test('a move next to one of the pins being moved leaves the order alone', () => {
    /* Given */
    const order = ['a', 'b', 'c'];

    /* When */
    const moved = moveBlock(order, ['a', 'b'], {after: 'b'}, same);

    /* Then */
    assert.deepEqual(moved, ['a', 'b', 'c']);
});

test('a move of pins that are not in the section leaves the order alone', () => {
    /* Given */
    const order = ['a', 'b'];

    /* When */
    const moved = moveBlock(order, ['x'], {before: 'a'}, same);

    /* Then */
    assert.deepEqual(moved, ['a', 'b']);
});

test('a new pin goes to the end of its section', () => {
    /* Given */
    const order = ['a', 'b'];

    /* When */
    const pinned = appendPin(order, 'c', same);

    /* Then */
    assert.deepEqual(pinned, ['a', 'b', 'c']);
});

test('a pin already in the section that is pinned again moves to the end, once', () => {
    /* Given */
    const order = ['a', 'b', 'c'];

    /* When */
    const pinned = appendPin(order, 'a', same);

    /* Then */
    assert.deepEqual(pinned, ['b', 'c', 'a']);
});

test('unpinning takes the pin out and leaves the rest in their order', () => {
    /* Given */
    const order = ['a', 'b', 'c'];

    /* When */
    const unpinned = withoutPin(order, 'b', same);

    /* Then */
    assert.deepEqual(unpinned, ['a', 'c']);
});

test('pins order by position, lowest first', () => {
    /* Given */
    const pins = [
        {id: 'c', position: 2, time: 3},
        {id: 'a', position: 0, time: 1},
        {id: 'b', position: 1, time: 2},
    ];

    /* When */
    const ordered = orderPins(
        pins,
        (p) => p.position,
        (p) => p.time,
    );

    /* Then */
    assert.deepEqual(
        ordered.map((p) => p.id),
        ['a', 'b', 'c'],
    );
});

test('pins without a position come after the placed ones, newest first, as they showed before', () => {
    /* Given */
    const pins = [
        {id: 'old', position: null, time: 1},
        {id: 'placed', position: 0, time: 0},
        {id: 'new', position: null, time: 5},
    ];

    /* When */
    const ordered = orderPins(
        pins,
        (p) => p.position,
        (p) => p.time,
    );

    /* Then */
    assert.deepEqual(
        ordered.map((p) => p.id),
        ['placed', 'new', 'old'],
    );
});

test('a missing position sorts after any position, and two missing ones tie', () => {
    /* When */
    const results = [
        comparePinPositions(undefined, 0),
        comparePinPositions(0, null),
        comparePinPositions(null, undefined),
        comparePinPositions(3, 1),
    ];

    /* Then */
    assert.deepEqual(
        results.map((n) => Math.sign(n)),
        [1, -1, 0, 1],
    );
});

test('slug plans and GitHub plans share the Pinned plans section; sessions and projects have their own', () => {
    /* Given */
    const refs: PinRef[] = [
        {kind: 'session', sessionId: 's'},
        {kind: 'project', projectPath: '/p'},
        {kind: 'plan', projectPath: '/p', slug: 'x'},
        {kind: 'issuePlan', projectPath: '/p', repository: 'o/r', number: 1},
    ];

    /* When */
    const sections = refs.map(pinSection);

    /* Then */
    assert.deepEqual(sections, ['sessions', 'projects', 'plans', 'plans']);
});

test('the same plan pinned in two projects is two pins', () => {
    /* When */
    const keys = [
        pinKey({kind: 'issuePlan', projectPath: '/a', repository: 'o/r', number: 1}),
        pinKey({kind: 'issuePlan', projectPath: '/b', repository: 'o/r', number: 1}),
    ];

    /* Then */
    assert.notEqual(keys[0], keys[1]);
});
