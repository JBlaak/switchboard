/** A schedule's runs, newest first, with a marker wherever the prompt changed; and the prompt card's line. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {firstRunItems, promptLine, runListItems} from '../src/domain/schedule/run-list';
import {NOW, at, run, version} from './support/schedule-fixtures';

const VERSIONS = [
    version(3, at(19, 16, 10), 'skip warnings with no users'),
    version(2, at(12, 9)),
    version(1, at(1, 9)),
];

test('a marker stands above the first run of each newer prompt', () => {
    /* Given */
    const runs = [
        run('d', {promptVersion: 3}),
        run('c', {promptVersion: 3}),
        run('b', {promptVersion: 2}),
        run('a', {promptVersion: 1}),
    ];

    /* When */
    const items = runListItems(runs, VERSIONS, 3, NOW);

    /* Then */
    assert.deepEqual(
        items.map((item) => (item.kind === 'run' ? item.run.id : item.text)),
        [
            'd',
            'c',
            'Prompt changed to v3, Thu 16:10: skip warnings with no users',
            'b',
            'Prompt changed to v2, 12 Nov 09:00',
            'a',
        ],
    );
});

test('a version saved since the newest run has its marker on top', () => {
    /* Given */
    const runs = [run('a', {promptVersion: 3})];
    const versions = [version(4, at(23, 10), null), ...VERSIONS];

    /* When */
    const items = runListItems(runs, versions, 4, NOW);

    /* Then */
    assert.deepEqual(
        items.map((item) => (item.kind === 'run' ? item.run.id : item.text)),
        ['Prompt changed to v4, Mon 10:00', 'a'],
    );
});

test('the prompt line says the version, when it was edited and the runs on it since', () => {
    /* Given */
    const runs = [
        run('c', {promptVersion: 3}),
        run('skipped', {promptVersion: 3, status: 'skipped'}),
        run('b', {promptVersion: 3}),
        run('a', {promptVersion: 2}),
    ];

    /* When */
    const line = promptLine(runs, VERSIONS, 3, NOW);
    const fresh = promptLine([], [], 1, NOW);

    /* Then */
    assert.equal(line, 'v3 · edited Thu · 2 runs since');
    assert.equal(fresh, 'v1 · 0 runs since');
});

test('Show older cuts after the first runs, a marker heading only hidden runs with them', () => {
    /* Given */
    const runs = [run('c', {promptVersion: 2}), run('b', {promptVersion: 1}), run('a', {promptVersion: 1})];
    const items = runListItems(runs, VERSIONS, 2, NOW);

    /* When */
    const one = firstRunItems(items, 1);
    const two = firstRunItems(items, 2);
    const all = firstRunItems(items, 5);

    /* Then */
    assert.deepEqual(
        one.map((item) => (item.kind === 'run' ? item.run.id : 'marker')),
        ['c'],
    );
    assert.deepEqual(
        two.map((item) => (item.kind === 'run' ? item.run.id : 'marker')),
        ['c', 'marker', 'b'],
    );
    assert.equal(all.length, items.length);
});
