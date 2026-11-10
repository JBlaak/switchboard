import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planProgress, progressCounts, sameProgress} from '../src/domain/plan/plan-progress';
import {diamond, merged, needs, plan, pr} from './support/plans';

test('a plan’s progress counts, per level, its issues, the closed ones, the ones with a PR and the ready ones', () => {
    /* Given */
    const diamondPlan = diamond();

    /* When */
    const progress = planProgress(diamondPlan);

    /* Then */
    assert.deepEqual(progress, {
        current: 1,
        levels: [
            {total: 2, done: 1, started: 0, ready: 1},
            {total: 2, done: 0, started: 1, ready: 1},
            {total: 1, done: 0, started: 0, ready: 0},
        ],
    });
});

test('a draft PR counts as started, and a not planned issue as done', () => {
    /* Given */
    const drafted = plan([
        needs(1, [], {state: 'closed', closedAs: 'not_planned'}),
        needs(2, [1], {pullRequests: [pr(102, 'open', true)]}),
    ]);

    /* When */
    const progress = planProgress(drafted);

    /* Then */
    assert.deepEqual(progress.levels, [
        {total: 1, done: 1, started: 0, ready: 0},
        {total: 1, done: 0, started: 1, ready: 0},
    ]);
    assert.equal(progress.current, 2);
});

test('a cleared plan is on no level', () => {
    /* Given */
    const cleared = plan([merged(1), merged(2, [1])]);

    /* When */
    const progress = planProgress(cleared);

    /* Then */
    assert.equal(progress.current, null);
    assert.deepEqual(progressCounts(progress), {done: 2, total: 2});
});

test('progress counts add up across levels', () => {
    /* Given */
    const progress = planProgress(diamond());

    /* When */
    const counts = progressCounts(progress);

    /* Then */
    assert.deepEqual(counts, {done: 1, total: 5});
});

test('two progresses with the same numbers are the same, and differ once one number does', () => {
    /* Given */
    const a = planProgress(diamond());
    const b = planProgress(diamond());
    const c = planProgress(plan([merged(10), merged(11, [10])]));

    /* Then */
    assert.equal(sameProgress(a, b), true);
    assert.equal(sameProgress(a, c), false);
});
