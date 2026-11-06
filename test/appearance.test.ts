import {test} from 'node:test';
import assert from 'node:assert/strict';

import {DEFAULT_APPEARANCE, isAppearance, normaliseAppearance} from '../src/domain/settings/appearance';

test('recognises each of the three modes', () => {
    /* Given */
    const modes = ['system', 'light', 'dark'];

    /* When */
    const recognised = modes.map(isAppearance);

    /* Then */
    assert.deepEqual(recognised, [true, true, true]);
});

test('recognises nothing but the three modes', () => {
    /* Given */
    const others: unknown[] = ['Dark', '', null, undefined, 1];

    /* When */
    const recognised = others.map(isAppearance);

    /* Then */
    assert.deepEqual(recognised, [false, false, false, false, false]);
});

test('the default is to follow the system', () => {
    /* Then */
    assert.equal(DEFAULT_APPEARANCE, 'system');
});

test('a stored mode survives normalising', () => {
    /* When */
    const light = normaliseAppearance('light');
    const dark = normaliseAppearance('dark');
    const system = normaliseAppearance('system');

    /* Then */
    assert.equal(light, 'light');
    assert.equal(dark, 'dark');
    assert.equal(system, 'system');
});

test('a mode that was never written falls back to system', () => {
    // A fresh install, or a blob from before the toggle existed.
    /* When */
    const mode = normaliseAppearance(undefined);

    /* Then */
    assert.equal(mode, 'system');
});

test('a mode cleared by the settings panel falls back to system', () => {
    /* When */
    const mode = normaliseAppearance(null);

    /* Then */
    assert.equal(mode, 'system');
});

test('a hand-edited or newer-build mode falls back to system rather than reaching themeSource', () => {
    /* When */
    const unknownName = normaliseAppearance('sepia');
    const unknownShape = normaliseAppearance({mode: 'dark'});

    /* Then */
    assert.equal(unknownName, 'system');
    assert.equal(unknownShape, 'system');
});
