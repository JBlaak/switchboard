import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PINNED_PLAN_STALE_MS, pinnedPlanStaleText} from '../src/renderer/ui/session-list/pinned-plan-freshness';

const NOW = new Date(2026, 10, 16, 14, 0).getTime();
const MINUTE = 60_000;

test('a row read within two polls is fresh', () => {
    /* Given */
    const read = {fetchedAt: NOW - PINNED_PLAN_STALE_MS, failed: false};

    /* When */
    const text = pinnedPlanStaleText(read, NOW, null);

    /* Then */
    assert.equal(text, null);
});

test('a row whose last read is more than two polls old says how old', () => {
    /* Given */
    const read = {fetchedAt: NOW - 14 * MINUTE, failed: false};

    /* When */
    const text = pinnedPlanStaleText(read, NOW, null);

    /* Then */
    assert.equal(text, 'Updated 14m ago');
});

test('a row whose last read failed says so, however recent the one before', () => {
    /* Given */
    const read = {fetchedAt: NOW - MINUTE, failed: true};

    /* When */
    const text = pinnedPlanStaleText(read, NOW, null);

    /* Then */
    assert.equal(text, 'Updated 1m ago · Couldn’t refresh');
});

test('a row whose first read failed says only that', () => {
    /* When */
    const text = pinnedPlanStaleText({fetchedAt: null, failed: true}, NOW, null);

    /* Then */
    assert.equal(text, 'Couldn’t refresh');
});

test('a row with no live read yet is refreshing, not out of date', () => {
    /* When */
    const text = pinnedPlanStaleText(undefined, NOW, null);

    /* Then */
    assert.equal(text, null);
});

test('while GitHub’s budget is held every row says its reads are paused, even before its first read', () => {
    /* Given */
    const until = new Date(2026, 10, 16, 14, 20).getTime();

    /* When */
    const fresh = pinnedPlanStaleText({fetchedAt: NOW - MINUTE, failed: false}, NOW, until);
    const first = pinnedPlanStaleText(undefined, NOW, until);

    /* Then */
    assert.equal(fresh, 'Updated 1m ago · Paused: GitHub budget low until 14:20');
    assert.equal(first, 'Paused: GitHub budget low until 14:20');
});

test('a hold that has passed marks nothing', () => {
    /* When */
    const text = pinnedPlanStaleText({fetchedAt: NOW - MINUTE, failed: false}, NOW, NOW - MINUTE);

    /* Then */
    assert.equal(text, null);
});
