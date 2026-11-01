import test from 'node:test';
import assert from 'node:assert/strict';

import {roleMenu} from '../src/infrastructure/electron/support/role-menu';

test('a role menu puts a separator between groups and none at either end', () => {
    /* Given */
    const groups = [['undo', 'redo'], ['copy']] as const;

    /* When */
    const menu = roleMenu('Edit', groups);

    /* Then */
    assert.deepEqual(menu, {
        label: 'Edit',
        submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'copy'}],
    });
});

test('a role menu of one group has no separator', () => {
    /* Given */
    const groups = [['quit']] as const;

    /* When */
    const menu = roleMenu('App', groups);

    /* Then */
    assert.deepEqual(menu.submenu, [{role: 'quit'}]);
});
