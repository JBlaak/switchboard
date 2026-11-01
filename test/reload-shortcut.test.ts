import test from 'node:test';
import assert from 'node:assert/strict';

import {isReloadShortcut} from '../src/infrastructure/electron/support/reload-shortcut';

const press = (
    key: string,
    modifiers: {meta?: boolean; control?: boolean; shift?: boolean} = {},
    type = 'keyDown',
) => ({
    type,
    key,
    meta: modifiers.meta ?? false,
    control: modifiers.control ?? false,
    shift: modifiers.shift ?? false,
});

test('Cmd+R and Ctrl+Shift+R are reloads, whatever the case of the key', () => {
    /* Given */
    const presses = [
        press('r', {meta: true}),
        press('R', {meta: true, shift: true}),
        press('R', {control: true, shift: true}),
    ];

    /* When */
    const reloads = presses.map(isReloadShortcut);

    /* Then */
    assert.deepEqual(reloads, [true, true, true]);
});

test('Ctrl+R, a plain R and other Cmd keys reach the terminal', () => {
    /* Given */
    const presses = [press('r', {control: true}), press('r'), press('c', {meta: true})];

    /* When */
    const reloads = presses.map(isReloadShortcut);

    /* Then */
    assert.deepEqual(reloads, [false, false, false]);
});

test('only the key going down counts, not its release', () => {
    /* Given */
    const release = press('r', {meta: true}, 'keyUp');

    /* When */
    const reload = isReloadShortcut(release);

    /* Then */
    assert.equal(reload, false);
});
