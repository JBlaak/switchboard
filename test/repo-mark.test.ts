/**
 * A project's little coloured mark (`repoMark`): its initial and a colour that
 * follows from its short name alone, so the managers agree on it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REPO_HUES, repoKey, repoMark} from '../src/renderer/ui/shared/repo-mark';

test('a repository, a local folder and a plain name of one project share its key', () => {
    /* Given */
    const names = ['JBlaak/switchboard', '/Users/joris/Development/switchboard/', 'Switchboard', ' switchboard '];

    /* When */
    const keys = names.map(repoKey);

    /* Then */
    assert.deepEqual(keys, ['switchboard', 'switchboard', 'switchboard', 'switchboard']);
});

test('one project gets one mark wherever it is named', () => {
    /* Given */
    const repository = 'JBlaak/switchboard';
    const folder = '/Users/joris/Development/switchboard';

    /* When */
    const marks = [repoMark(repository), repoMark(folder), repoMark('Switchboard')];

    /* Then */
    assert.equal(marks[0]!.initial, 'S');
    assert.ok(REPO_HUES.includes(marks[0]!.hue));
    assert.deepEqual(marks[1], marks[0]);
    assert.deepEqual(marks[2], marks[0]);
});

test('projects spread over the colours', () => {
    /* Given */
    const names = ['switchboard', 'patch', 'blaaktasks', 'nohrd-android', 'connect', 'james', 'tern', 'planner'];

    /* When */
    const hues = new Set(names.map((name) => repoMark(name).hue));

    /* Then */
    assert.ok(hues.size >= 4, `only ${[...hues].join(', ')}`);
});

test('a name without a letter or digit to start from gets a question mark', () => {
    /* Given */
    const names = ['', '/', '---'];

    /* When */
    const initials = names.map((name) => repoMark(name).initial);

    /* Then */
    assert.deepEqual(initials, ['?', '?', '?']);
});
