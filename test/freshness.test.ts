import {test} from 'node:test';
import assert from 'node:assert/strict';

import {freshnessLine, freshnessText} from '../src/renderer/ui/shared/freshness-text';
import {githubReducer, initialGithubState} from '../src/renderer/state/github-slice';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';

const MINUTE = 60_000;
/** 14:00 local time, so the held time reads the same in any timezone. */
const NOW = new Date(2026, 10, 16, 14, 0).getTime();
const AT_14_20 = new Date(2026, 10, 16, 14, 20).getTime();

// ── The line's words ──

test('a read three minutes ago is "Updated 3m ago"', () => {
    /* When */
    const text = freshnessText({fetchedAt: NOW - 3 * MINUTE}, NOW, null);

    /* Then */
    assert.equal(text, 'Updated 3m ago');
});

test('a read stamped a moment after the clock last ticked is "just now", never in the future', () => {
    /* When */
    const text = freshnessText({fetchedAt: NOW + 5_000}, NOW, null);

    /* Then */
    assert.equal(text, 'Updated just now');
});

test('nothing read, nothing in flight and nothing held says nothing', () => {
    /* When */
    const line = freshnessLine({fetchedAt: null}, NOW, null);

    /* Then */
    assert.equal(line, null);
});

test('extra parts follow the main age, and a part never read is left out', () => {
    /* When */
    const text = freshnessText(
        {
            fetchedAt: NOW - 2 * MINUTE,
            parts: [
                {label: 'plans', at: NOW - 4 * MINUTE},
                {label: 'tags', at: null},
            ],
        },
        NOW,
        null,
    );

    /* Then */
    assert.equal(text, 'Updated 2m ago · plans 4m ago');
});

test('a read in flight adds "Updating…" as a refreshing status', () => {
    /* When */
    const line = freshnessLine({fetchedAt: NOW - 2 * MINUTE, refreshing: true}, NOW, null);

    /* Then */
    assert.deepEqual(line, {ages: 'Updated 2m ago', status: {kind: 'refreshing', text: 'Updating…'}});
});

test('a first read in flight is "Updating…" alone', () => {
    /* When */
    const text = freshnessText({fetchedAt: null, refreshing: true}, NOW, null);

    /* Then */
    assert.equal(text, 'Updating…');
});

test('a failed read says the data shown is older', () => {
    /* When */
    const line = freshnessLine({fetchedAt: NOW - 10 * MINUTE, failed: true}, NOW, null);

    /* Then */
    assert.deepEqual(line, {ages: 'Updated 10m ago', status: {kind: 'failed', text: 'Couldn’t refresh'}});
});

test('a held budget says until when, in place of the spinner or the failure', () => {
    /* When */
    const line = freshnessLine({fetchedAt: NOW - 5 * MINUTE, refreshing: true, failed: true}, NOW, AT_14_20);

    /* Then */
    assert.deepEqual(line, {
        ages: 'Updated 5m ago',
        status: {kind: 'held', text: 'Paused: GitHub budget low until 14:20'},
    });
});

test('a hold whose time has passed is not shown', () => {
    /* When */
    const text = freshnessText({fetchedAt: NOW - 5 * MINUTE}, NOW, NOW - 1);

    /* Then */
    assert.equal(text, 'Updated 5m ago');
});

test('a view whose reads are never held opts out of the hold', () => {
    /* When */
    const text = freshnessText({fetchedAt: NOW - MINUTE, refreshing: true, showHeld: false}, NOW, AT_14_20);

    /* Then */
    assert.equal(text, 'Updated 1m ago · Updating…');
});

test('a hold shows even before anything was read', () => {
    /* When */
    const text = freshnessText({fetchedAt: null}, NOW, AT_14_20);

    /* Then */
    assert.equal(text, 'Paused: GitHub budget low until 14:20');
});

// ── The store ──

test('githubBudgetHeld records until when GitHub reads are held', () => {
    /* When */
    const state = githubReducer(initialGithubState, {type: 'githubBudgetHeld', until: AT_14_20});

    /* Then */
    assert.deepEqual(state, {heldUntil: AT_14_20});
});

test('githubBudgetHeld with null lifts the hold', () => {
    /* Given */
    const held = githubReducer(initialGithubState, {type: 'githubBudgetHeld', until: AT_14_20});

    /* When */
    const state = githubReducer(held, {type: 'githubBudgetHeld', until: null});

    /* Then */
    assert.equal(state.heldUntil, null);
});

test('the same hold told again leaves the whole state as it was', () => {
    /* Given */
    const state = rootReducer(initialRendererState(), {type: 'githubBudgetHeld', until: AT_14_20});

    /* When */
    const next = rootReducer(state, {type: 'githubBudgetHeld', until: AT_14_20});

    /* Then */
    assert.strictEqual(next, state);
    assert.equal(next.github.heldUntil, AT_14_20);
});
