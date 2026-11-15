/**
 * The Merge manager's progress bars between reads: they fill toward their
 * step's expected time, never behind the last read, never quite full, and
 * slide once the step runs past it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FILL_CAP, barProgress} from '../src/domain/merge-manager/progress';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 15, 12, 0);

test('a step a quarter of the way through its expected time fills from a quarter of the way on', () => {
    /* Given */
    const timing = {actual: null, startedAt: NOW - 2 * MIN, expectedMs: 8 * MIN};

    /* When */
    const bar = barProgress(timing, NOW);

    /* Then */
    assert.deepEqual(bar, {kind: 'filling', from: FILL_CAP / 4, to: FILL_CAP, remainingMs: 6 * MIN});
});

test('a bar never shows less than the last read said', () => {
    /* Given: two of three checks passed, a minute into an eight-minute run */
    const timing = {actual: 2 / 3, startedAt: NOW - MIN, expectedMs: 8 * MIN};

    /* When */
    const bar = barProgress(timing, NOW);

    /* Then */
    assert.equal(bar.kind, 'filling');
    assert.equal(bar.kind === 'filling' && bar.from, 2 / 3);
});

test('a bar stops short of full until the step is done, even with every check passed', () => {
    /* Given */
    const timing = {actual: 1, startedAt: NOW - MIN, expectedMs: 8 * MIN};

    /* When */
    const bar = barProgress(timing, NOW);

    /* Then */
    assert.equal(bar.kind === 'filling' && bar.from, FILL_CAP);
});

test('a step past its expected time slides instead', () => {
    /* Given */
    const timing = {actual: 0.5, startedAt: NOW - 9 * MIN, expectedMs: 8 * MIN};

    /* When */
    const bar = barProgress(timing, NOW);

    /* Then */
    assert.deepEqual(bar, {kind: 'indeterminate'});
});

test('with nothing to time it by, a bar stays at the last read, or slides when there is none', () => {
    /* Given */
    const noRuns = {actual: 0.5, startedAt: NOW - MIN, expectedMs: null};
    const nothing = {actual: null, startedAt: null, expectedMs: 8 * MIN};

    /* When */
    const fromRead = barProgress(noRuns, NOW);
    const unknown = barProgress(nothing, NOW);

    /* Then */
    assert.deepEqual(fromRead, {kind: 'fixed', value: 0.5});
    assert.deepEqual(unknown, {kind: 'indeterminate'});
});

test('a step done or still to come stays put', () => {
    /* Given */
    const done = 1;
    const todo = 0;

    /* When */
    const bars = [barProgress(done, NOW), barProgress(todo, NOW)];

    /* Then */
    assert.deepEqual(bars, [
        {kind: 'fixed', value: 1},
        {kind: 'fixed', value: 0},
    ]);
});
