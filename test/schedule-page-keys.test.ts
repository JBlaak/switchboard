/** What a key does on the Schedule manager's page: the overview's and a schedule's own. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {overviewKeyAction, scheduleKeyAction} from '../src/renderer/ui/schedule-manager/page-keys';
import {run, summary} from './support/schedule-fixtures';

test('on the overview J/K move, N is New, and the rest act on the chosen schedule', () => {
    /* Given */
    const chosen = summary('a', {last: run('r', {status: 'failed', seen: false})});

    /* When */
    const actions = ['j', 'ArrowUp', 'n', 'Enter', 'r', 'p', 'e', 's', 'x'].map((key) =>
        overviewKeyAction(key, chosen),
    );

    /* Then */
    assert.deepEqual(actions, [
        {kind: 'step', step: 1},
        {kind: 'step', step: -1},
        {kind: 'new'},
        {kind: 'open', key: 'a'},
        {kind: 'runNow', key: 'a'},
        {kind: 'pause', key: 'a'},
        {kind: 'editPrompt', key: 'a'},
        {kind: 'seen', run: chosen.last},
        null,
    ]);
});

test('with nothing chosen only moving and New do anything, and S needs an unseen finished run', () => {
    /* When */
    const none = ['Enter', 'r', 'k'].map((key) => overviewKeyAction(key, null));
    const seen = overviewKeyAction('s', summary('a', {last: run('r', {seen: true})}));
    const running = overviewKeyAction('s', summary('a', {last: run('r', {seen: false, status: 'running'})}));

    /* Then */
    assert.deepEqual(none, [null, null, {kind: 'step', step: -1}]);
    assert.equal(seen, null);
    assert.equal(running, null);
});

test("on a schedule's page ⏎, S and C act on the chosen run, and R, P, E on the schedule", () => {
    /* Given */
    const chosen = run('r', {seen: false});

    /* When */
    const actions = ['Enter', 's', 'c', 'r', 'p', 'e', 'k'].map((key) => scheduleKeyAction(key, 'key', chosen));

    /* Then */
    assert.deepEqual(actions, [
        {kind: 'toggleRun', run: chosen},
        {kind: 'seen', run: chosen},
        {kind: 'carryOn', run: chosen},
        {kind: 'runNow', key: 'key'},
        {kind: 'pause', key: 'key'},
        {kind: 'editPrompt', key: 'key'},
        {kind: 'step', step: -1},
    ]);
});

test('C needs a run that had a session, and S one not seen yet', () => {
    /* When */
    const carry = scheduleKeyAction('c', 'key', run('r', {sessionId: null}));
    const seen = scheduleKeyAction('s', 'key', run('r', {seen: true}));
    const none = scheduleKeyAction('Enter', 'key', null);

    /* Then */
    assert.equal(carry, null);
    assert.equal(seen, null);
    assert.equal(none, null);
});
