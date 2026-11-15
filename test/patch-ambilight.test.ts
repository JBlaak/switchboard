/** The family card's Ambilight: each figure on the floor throws its colour straight below where it stands. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bottomGlows} from '../src/domain/companion/ambilight';

test('with every manager set up, four colours sit under the row, stepped left to stay centred', () => {
    /* When */
    const glows = bottomGlows({bug: true, issue: true});

    /* Then */
    assert.deepEqual(glows, [
        {figure: 'bug', x: -246},
        {figure: 'patch', x: -79},
        {figure: 'issue', x: 88},
        {figure: 'merge', x: 246},
    ]);
});

test('with only the Merge manager, Patch and it light the edge, the row still stepped left', () => {
    /* When */
    const glows = bottomGlows({bug: false, issue: false});

    /* Then */
    assert.deepEqual(glows, [
        {figure: 'patch', x: -79},
        {figure: 'merge', x: 88},
    ]);
});

test('with the Bug manager but no Issue manager, the row flanks Patch evenly at the centre', () => {
    /* When */
    const glows = bottomGlows({bug: true, issue: false});

    /* Then */
    assert.deepEqual(glows, [
        {figure: 'bug', x: -167},
        {figure: 'patch', x: 0},
        {figure: 'merge', x: 167},
    ]);
});

test('with the Issue manager but no Bug manager, the Merge manager stands after it', () => {
    /* When */
    const glows = bottomGlows({bug: false, issue: true});

    /* Then */
    assert.deepEqual(
        glows.map((glow) => glow.figure),
        ['patch', 'issue', 'merge'],
    );
    assert.equal(glows.at(-1)!.x, 246);
});
