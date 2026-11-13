/**
 * The managers' inbox, renderer side (#413): the counts main pushes, and the
 * figure each manager shows on the empty screen for them (#416).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {managerCountsOf, managerFigureOf} from '../src/renderer/state/inbox-slice';
import type {InboxSummary} from '../src/domain/inbox/model';

const SUMMARY: InboxSummary = {
    bug: {unread: 3, urgent: 1},
    issue: {unread: 2, urgent: 0},
    configured: {bug: true, issue: true},
};

/** The state after main pushed `summary`. */
const pushed = (summary: InboxSummary) => rootReducer(initialRendererState(), {type: 'inboxChanged', summary}).inbox;

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

test('a manager that comes or goes is a change, with the same counts', () => {
    /* Given */
    const state = rootReducer(initialRendererState(), {type: 'inboxChanged', summary: SUMMARY});

    /* When */
    const next = rootReducer(state, {
        type: 'inboxChanged',
        summary: {...SUMMARY, configured: {bug: true, issue: false}},
    });

    /* Then */
    assert.notEqual(next, state);
});

test('a manager that is not set up has no figure, whatever its counts', () => {
    /* When */
    const inbox = pushed({...SUMMARY, configured: {bug: false, issue: true}});

    /* Then */
    assert.equal(managerFigureOf(inbox, 'bug'), null);
    assert.notEqual(managerFigureOf(inbox, 'issue'), null);
});

test('no figure before main has said anything', () => {
    /* When */
    const state = initialRendererState();

    /* Then */
    assert.equal(managerFigureOf(state.inbox, 'bug'), null);
    assert.equal(managerFigureOf(state.inbox, 'issue'), null);
});

test('nothing unread is calm, with no count', () => {
    /* When */
    const inbox = pushed({...SUMMARY, bug: {unread: 0, urgent: 0}});

    /* Then */
    assert.deepEqual(managerFigureOf(inbox, 'bug'), {pose: 'calm', count: 0});
});

test('something unread holds the prop up, counted', () => {
    /* When */
    const inbox = pushed({...SUMMARY, bug: {unread: 4, urgent: 0}});

    /* Then */
    assert.deepEqual(managerFigureOf(inbox, 'bug'), {pose: 'unread', count: 4});
    assert.deepEqual(managerFigureOf(inbox, 'issue'), {pose: 'unread', count: 2});
});

test('an unread trending or regressed bug is urgent, counting every unread item', () => {
    /* When */
    const inbox = pushed(SUMMARY);

    /* Then */
    assert.deepEqual(managerFigureOf(inbox, 'bug'), {pose: 'urgent', count: 3});
});
