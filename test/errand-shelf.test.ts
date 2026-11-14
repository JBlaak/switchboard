import {test} from 'node:test';
import assert from 'node:assert/strict';

import {errandHeaderText, errandsBySession, shortRepository} from '../src/domain/session/errand-shelf';
import {EMPTY_MERGE_MANAGER_STATE} from '../src/domain/merge-manager/model';
import type {LaneStage, MergeManagerState} from '../src/domain/merge-manager/model';
import {landedPr, REPO} from './support/merge-manager-fixtures';
import {errand} from './support/merge-queue-fixtures';

function managerWith(stage: LaneStage, errandSession: string | null, merging?: MergeManagerState['merging']) {
    const pr = {...landedPr(431, 5, 'switchboard', stage, {errand: errandSession}), place: null};
    return {
        lanes: [{repository: REPO, kind: 'switchboard', approvalLostOnPush: false, pullRequests: [pr]}],
        needsYou: 0,
        merging,
    } as MergeManagerState;
}

test('a fix errand on a PR that failed its checks is fixing checks', () => {
    /* Given */
    const merge = managerWith({kind: 'fixing', cause: 'checks'}, 's-1');

    /* When */
    const errands = errandsBySession(merge, {});

    /* Then */
    assert.deepEqual(errands.get('s-1'), {
        sessionId: 's-1',
        kind: 'fix',
        owner: 'merge-manager',
        repository: REPO,
        number: 431,
        doing: 'fixing checks',
        needsYou: false,
        host: null,
    });
});

test('a fix errand on a conflict is rebasing', () => {
    /* Given */
    const merge = managerWith({kind: 'fixing', cause: 'conflict'}, 's-1');

    /* When */
    const doing = errandsBySession(merge, {}).get('s-1')?.doing;

    /* Then */
    assert.equal(doing, 'rebasing');
});

test('a fix errand that stopped on a question needs you', () => {
    /* Given */
    const merge = managerWith({kind: 'needsYou', reason: {kind: 'errand-stopped', question: 'Which side?'}}, 's-1');

    /* When */
    const entry = errandsBySession(merge, {}).get('s-1');

    /* Then */
    assert.equal(entry?.doing, 'stopped: asks');
    assert.equal(entry?.needsYou, true);
});

test('a fix errand whose PR went back to its place is finishing, and one on a merged PR is gone', () => {
    /* Given */
    const waiting = managerWith({kind: 'waiting', willConflict: false, position: null}, 's-1');
    const merged = managerWith({kind: 'merged', at: 0}, 's-2');

    /* When */
    const finishing = errandsBySession(waiting, {}).get('s-1');
    const gone = errandsBySession(merged, {}).get('s-2');

    /* Then */
    assert.equal(finishing?.doing, 'finishing');
    assert.equal(gone, undefined);
});

test('errands running on a VM carry its name', () => {
    /* Given */
    const merge = managerWith({kind: 'fixing', cause: 'checks'}, 's-1', {
        kind: 'vm',
        vm: {key: 'vm-1', name: 'builder'},
    } as MergeManagerState['merging']);

    /* When */
    const host = errandsBySession(merge, {}).get('s-1')?.host;

    /* Then */
    assert.equal(host, 'builder');
});

test('queue errands count from their session until done', () => {
    /* Given */
    const queue = {
        [REPO]: [
            errand('n-1', {kind: 'nudge', number: 398}),
            errand('f-1', {kind: 'fix', state: 'needs-you'}),
            errand('f-2', {state: 'done'}),
            errand(null),
        ],
    };

    /* When */
    const errands = errandsBySession(EMPTY_MERGE_MANAGER_STATE, queue);

    /* Then */
    assert.deepEqual([...errands.keys()], ['n-1', 'f-1']);
    assert.equal(errands.get('n-1')?.doing, 'nudging the reviewer');
    assert.equal(errands.get('n-1')?.owner, 'queue');
    assert.equal(errands.get('f-1')?.needsYou, true);
});

test('the header names the owner, what it does and on which PR', () => {
    /* Given */
    const entry = errandsBySession(managerWith({kind: 'fixing', cause: 'checks'}, 's-1'), {}).get('s-1')!;

    /* When */
    const text = errandHeaderText(entry);

    /* Then */
    assert.equal(text, 'Errand for the Merge manager · fixing checks on #431 · archives itself');
    assert.equal(shortRepository('owner/repo'), 'repo');
});
