/**
 * The sidebar's pull request list's own state: its cursor, and its read in
 * flight until any read of the open PRs answers.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialSidebarPrsState, sidebarPrsReducer} from '../src/renderer/state/sidebar-prs-slice';

test('the cursor moves to a row and goes again', () => {
    /* Given */
    const start = initialSidebarPrsState;

    /* When */
    const on = sidebarPrsReducer(start, {type: 'pullRequestListCursorSet', key: 'movelab/connect#5'});
    const off = sidebarPrsReducer(on, {type: 'pullRequestListCursorSet', key: null});

    /* Then */
    assert.equal(on.cursor, 'movelab/connect#5');
    assert.equal(off.cursor, null);
});

test('a read is in flight until the open PRs are loaded, failed or not', () => {
    /* Given */
    const reading = sidebarPrsReducer(initialSidebarPrsState, {type: 'pullRequestListReadStarted'});

    /* When */
    const answered = sidebarPrsReducer(reading, {
        type: 'mergeManagerNotLandedLoaded',
        pullRequests: null,
        fetchedAt: null,
        failed: true,
    });

    /* Then */
    assert.equal(reading.reading, true);
    assert.equal(answered.reading, false);
});

test('an event about something else keeps the same state', () => {
    /* Given */
    const start = initialSidebarPrsState;

    /* When */
    const after = sidebarPrsReducer(start, {type: 'sidebarPageShown', page: 'pullRequests'});

    /* Then */
    assert.equal(after, start);
});
