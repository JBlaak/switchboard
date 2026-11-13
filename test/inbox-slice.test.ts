/**
 * The managers' inbox, renderer side (#413): the counts main pushes.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {managerCountsOf} from '../src/renderer/state/inbox-slice';
import type {InboxSummary} from '../src/domain/inbox/model';

const SUMMARY: InboxSummary = {bug: {unread: 3, urgent: 1}, issue: {unread: 2, urgent: 0}};

test("a pushed summary gives each manager's counts", () => {
    /* When */
    const state = rootReducer(initialRendererState(), {type: 'inboxChanged', summary: SUMMARY});

    /* Then */
    assert.deepEqual(managerCountsOf(state.inbox, 'bug'), {unread: 3, urgent: 1});
    assert.deepEqual(managerCountsOf(state.inbox, 'issue'), {unread: 2, urgent: 0});
});

test('nothing unread before main has said anything', () => {
    /* When */
    const state = initialRendererState();

    /* Then */
    assert.deepEqual(managerCountsOf(state.inbox, 'bug'), {unread: 0, urgent: 0});
});

test('the same counts again change nothing', () => {
    /* Given */
    const state = rootReducer(initialRendererState(), {type: 'inboxChanged', summary: SUMMARY});

    /* When */
    const again = rootReducer(state, {type: 'inboxChanged', summary: structuredClone(SUMMARY)});

    /* Then */
    assert.equal(again, state);
});
