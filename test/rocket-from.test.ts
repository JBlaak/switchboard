/**
 * Where a Land it press launches its rocket: the button, or only the
 * session's row in the sidebar for the header's and the tray's Land it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rocketFrom} from '../src/renderer/lib/motion/rocket';

const button = {name: 'button'} as unknown as Element;
const row = {name: 'row'} as unknown as Element;

test('a Land it without a launch place launches from its button', () => {
    /* Given */
    const launchFrom = undefined;

    /* When */
    const from = rocketFrom(button, launchFrom);

    /* Then */
    assert.equal(from, button);
});

test("a session's Land it launches from the session's row when it is in sight", () => {
    /* Given */
    const launchFrom = () => row;

    /* When */
    const from = rocketFrom(button, launchFrom);

    /* Then */
    assert.equal(from, row);
});

test("a session's Land it launches nothing when the row is out of sight, never from the tray or header", () => {
    /* Given */
    const launchFrom = () => null;

    /* When */
    const from = rocketFrom(button, launchFrom);

    /* Then */
    assert.equal(from, undefined);
});
