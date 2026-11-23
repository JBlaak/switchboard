import {test} from 'node:test';
import assert from 'node:assert/strict';

import {errandHeaderText, errandsBySession, shortRepository, shortTitle} from '../src/domain/session/errand-shelf';
import {EMPTY_MERGE_MANAGER_STATE} from '../src/domain/merge-manager/model';
import type {LaneStage, MergeManagerState} from '../src/domain/merge-manager/model';
import {landedPr, REPO} from './support/merge-manager-fixtures';
import {errand} from './support/merge-queue-fixtures';
import {facts, local, run, schedule} from './support/schedule-shelf-fixtures';

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
    const errands = errandsBySession(merge, {}, []);

    /* Then */
    assert.deepEqual(errands.get('s-1'), {
        sessionId: 's-1',
        kind: 'fix',
        owner: 'merge-manager',
        repository: REPO,
        number: 431,
        title: null,
        doing: 'fixing checks',
        needsYou: false,
        host: null,
    });
});

test('a fix errand on a conflict is rebasing', () => {
    /* Given */
    const merge = managerWith({kind: 'fixing', cause: 'conflict'}, 's-1');

    /* When */
    const doing = errandsBySession(merge, {}, []).get('s-1')?.doing;

    /* Then */
    assert.equal(doing, 'rebasing');
});

test('a fix errand that stopped on a question needs you', () => {
    /* Given */
    const merge = managerWith({kind: 'needsYou', reason: {kind: 'errand-stopped', question: 'Which side?'}}, 's-1');

    /* When */
    const entry = errandsBySession(merge, {}, []).get('s-1');

    /* Then */
    assert.equal(entry?.doing, 'stopped: asks');
    assert.equal(entry?.needsYou, true);
});

test('a fix errand whose PR went back to its place is finishing, and one on a merged PR is gone', () => {
    /* Given */
    const waiting = managerWith({kind: 'waiting', willConflict: false, position: null}, 's-1');
    const merged = managerWith({kind: 'merged', at: 0}, 's-2');

    /* When */
    const finishing = errandsBySession(waiting, {}, []).get('s-1');
    const gone = errandsBySession(merged, {}, []).get('s-2');

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
    const host = errandsBySession(merge, {}, []).get('s-1')?.host;

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
    const errands = errandsBySession(EMPTY_MERGE_MANAGER_STATE, queue, []);

    /* Then */
    assert.deepEqual([...errands.keys()], ['n-1', 'f-1']);
    assert.equal(errands.get('n-1')?.doing, 'nudging the reviewer');
    assert.equal(errands.get('n-1')?.owner, 'queue');
    assert.equal(errands.get('f-1')?.needsYou, true);
});

test('the header names the owner, what it does and on which PR', () => {
    /* Given */
    const entry = errandsBySession(managerWith({kind: 'fixing', cause: 'checks'}, 's-1'), {}, []).get('s-1')!;

    /* When */
    const text = errandHeaderText(entry);

    /* Then */
    assert.equal(text, 'Errand for the Merge manager · fixing checks on #431 · archives itself');
    assert.equal(shortRepository('owner/repo'), 'repo');
});

// ── The Bug manager's quick triage ──

const TRIAGE = {
    sessionId: 't-1',
    key: 'bugsnag:proj:err-1',
    title: 'TypeError: Cannot read properties of undefined',
    repository: 'movelab/switchboard',
    needsYou: false,
};

test('a bug being triaged is a triage errand for the Bug manager, with no PR', () => {
    /* Given */
    const triaging = [TRIAGE];

    /* When */
    const errands = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, triaging);

    /* Then */
    assert.deepEqual(errands.get('t-1'), {
        sessionId: 't-1',
        kind: 'triage',
        owner: 'bug-manager',
        repository: 'movelab/switchboard',
        number: null,
        title: 'TypeError: Cannot read properties of undefined',
        doing: 'triaging',
        needsYou: false,
        host: null,
    });
});

test('a triage that stopped without a verdict needs you', () => {
    /* Given */
    const triaging = [{...TRIAGE, needsYou: true}];

    /* When */
    const entry = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, triaging).get('t-1');

    /* Then */
    assert.equal(entry?.doing, 'stopped');
    assert.equal(entry?.needsYou, true);
});

test('triages sit in the index beside the PR errands', () => {
    /* Given */
    const merge = managerWith({kind: 'fixing', cause: 'checks'}, 's-1');

    /* When */
    const errands = errandsBySession(merge, {}, [TRIAGE]);

    /* Then */
    assert.deepEqual([...errands.keys()], ['s-1', 't-1']);
});

test("the header names the Bug manager and the bug's short title", () => {
    /* Given */
    const entry = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [TRIAGE]).get('t-1')!;

    /* When */
    const text = errandHeaderText(entry);

    /* Then */
    assert.equal(
        text,
        'Errand for the Bug manager · triaging TypeError: Cannot read properties of un… · archives itself',
    );
});

test('the header says a stuck triage stopped', () => {
    /* Given */
    const entry = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [{...TRIAGE, title: 'Boom', needsYou: true}]).get(
        't-1',
    )!;

    /* When */
    const text = errandHeaderText(entry);

    /* Then */
    assert.equal(text, 'Errand for the Bug manager · stopped triaging Boom · archives itself');
});

test('a short title is kept whole; a long one is cut to 40 characters with an ellipsis', () => {
    /* Given */
    const short = 'Error:  out of\n memory';
    const long = 'x'.repeat(60);

    /* When */
    const cut = [shortTitle(short), shortTitle(long)];

    /* Then */
    assert.equal(cut[0], 'Error: out of memory');
    assert.equal(cut[1].length, 40);
    assert.ok(cut[1].endsWith('…'));
});

// ── Scheduled runs ──

test('a scheduled run the shelf lists is an errand of the Schedule manager, named after its schedule', () => {
    /* Given */
    const schedules = facts(
        [schedule('sweep', {settings: {name: 'Bugsnag sweep', projectPath: '/dev/switchboard'}})],
        [run('r-1', 'sweep', {status: 'running', dueAt: local(3), endedAt: null})],
    );

    /* When */
    const entry = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [], schedules).get('s-r-1');

    /* Then */
    assert.equal(entry?.kind, 'scheduled');
    assert.equal(entry?.owner, 'schedule');
    assert.equal(entry?.title, 'Bugsnag sweep');
    assert.equal(entry?.repository, '/dev/switchboard');
    assert.equal(entry?.number, null);
    assert.equal(entry?.doing, '03:00');
    assert.equal(entry?.needsYou, false);
    assert.equal(entry?.run?.id, 'r-1');
});

test('a scheduled run that hit its limit and is not seen needs you', () => {
    /* Given */
    const schedules = facts([schedule('sweep')], [run('r-1', 'sweep', {status: 'limit'})]);

    /* When */
    const entry = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [], schedules).get('s-r-1');

    /* Then */
    assert.equal(entry?.needsYou, true);
    assert.equal(entry?.doing, 'limit hit');
});

test('a seen run is no errand any more, and a run that never started has no session to be one', () => {
    /* Given */
    const schedules = facts(
        [schedule('sweep')],
        [run('seen', 'sweep', {seen: true}), run('missed', 'sweep', {status: 'missed', sessionId: null})],
    );

    /* When */
    const errands = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [], schedules);

    /* Then */
    assert.equal(errands.size, 0);
});

test('the header says whose scheduled run it is and how it goes', () => {
    /* Given */
    const schedules = facts(
        [schedule('sweep', {settings: {name: 'Bugsnag sweep'}})],
        [run('r-1', 'sweep', {status: 'running', startedAt: local(3, 1), endedAt: null})],
    );
    const entry = errandsBySession(EMPTY_MERGE_MANAGER_STATE, {}, [], schedules).get('s-r-1')!;

    /* When */
    const text = errandHeaderText(entry);

    /* Then */
    assert.equal(text, 'Scheduled run of Bugsnag sweep · running since 03:01');
});
