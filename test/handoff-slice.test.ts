/**
 * Project hand-off in the renderer's store (#276 stage 2): the hosts, a
 * project's copies and a copy's origin, the dialog's preview and ticks, a
 * hand-off's progress, success and failure, Bring back, and the decision
 * Remove copy makes from the copy's status. Stage 5: the dialog's schedules
 * checkbox and where each page's schedules run.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {
    bringBackIn,
    copiesIn,
    originIn,
    removalIn,
    removeDecision,
    runIn,
    schedulesIn,
} from '../src/renderer/state/handoff-slice';
import type {ScheduleLocation} from '../src/application/services/vm-schedules';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {CopyStatus, HandoffHost, HandoffPreview} from '../src/application/services/project-handoff';

const LOCAL = '/Users/me/code/app';
const COPY = 'ssh://dev@buildbox/home/dev/projects/app';
const HOST: HandoffHost = {key: 'dev@buildbox:22', label: 'dev@buildbox'};
const PREVIEW: HandoffPreview = {
    branch: 'feature/x',
    unpushed: 2,
    uncommitted: 3,
    candidates: [
        {path: '.env', size: 312, ticked: true},
        {path: '.env.local', size: 120, ticked: false},
    ],
    existing: {},
};
const CLEAN: CopyStatus = {branch: 'feature/x', unpushed: [], uncommitted: []};

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(): RendererState {
    return run(
        initialRendererState(),
        {type: 'handoffDialogOpened', localPath: LOCAL, host: HOST},
        {type: 'handoffPreviewLoaded', localPath: LOCAL, answer: PREVIEW},
    );
}

// ── Hosts, copies and origins ──

test('the hosts are unknown until main answers', () => {
    /* When */
    const state = run(initialRendererState(), {type: 'handoffHostsLoaded', hosts: [HOST]});

    /* Then */
    assert.equal(initialRendererState().handoff.hosts, null);
    assert.deepEqual(state.handoff.hosts, [HOST]);
});

test('a local project lists the copies main says it has', () => {
    /* Given */
    const copy = {copyPath: COPY, hostKey: HOST.key, hostLabel: HOST.label};

    /* When */
    const state = run(initialRendererState(), {type: 'handoffCopiesLoaded', localPath: LOCAL, copies: [copy]});

    /* Then */
    assert.deepEqual(copiesIn(state.handoff, LOCAL), [copy]);
    assert.deepEqual(copiesIn(state.handoff, '/other'), []);
});

test('a copy knows its local project, and a remote that is not a copy has none', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'handoffOriginLoaded', copyPath: COPY, origin: LOCAL},
        {type: 'handoffOriginLoaded', copyPath: 'ssh://me@box/x', origin: null},
    );

    /* Then */
    assert.equal(originIn(state.handoff, COPY), LOCAL);
    assert.equal(originIn(state.handoff, 'ssh://me@box/x'), null);
});

// ── The dialog ──

test('the dialog waits for the preview as it opens', () => {
    /* When */
    const state = run(initialRendererState(), {type: 'handoffDialogOpened', localPath: LOCAL, host: HOST});

    /* Then */
    assert.deepEqual(state.handoff.dialog, {
        localPath: LOCAL,
        host: HOST,
        preview: {phase: 'loading'},
        ticked: [],
        schedulesOnVm: true,
    });
});

test('the preview ticks the files that were ticked last time', () => {
    /* When */
    const state = opened();

    /* Then */
    assert.deepEqual(state.handoff.dialog?.ticked, ['.env']);
    assert.deepEqual(state.handoff.dialog?.preview, {phase: 'ok', preview: PREVIEW});
});

test('a preview error is kept to be shown in words', () => {
    /* Given */
    const state = run(initialRendererState(), {type: 'handoffDialogOpened', localPath: LOCAL, host: HOST});

    /* When */
    const next = run(state, {
        type: 'handoffPreviewLoaded',
        localPath: LOCAL,
        answer: {error: 'This folder isn’t a git repository.'},
    });

    /* Then */
    assert.deepEqual(next.handoff.dialog?.preview, {phase: 'error', error: 'This folder isn’t a git repository.'});
});

test('a preview for another project leaves the dialog alone', () => {
    /* Given */
    const state = run(initialRendererState(), {type: 'handoffDialogOpened', localPath: LOCAL, host: HOST});

    /* When */
    const next = run(state, {type: 'handoffPreviewLoaded', localPath: '/other', answer: PREVIEW});

    /* Then */
    assert.equal(next.handoff, state.handoff);
});

test('ticking and unticking a file changes what goes along', () => {
    /* Given */
    const state = opened();

    /* When */
    const next = run(
        state,
        {type: 'handoffFileToggled', path: '.env.local'},
        {type: 'handoffFileToggled', path: '.env'},
    );

    /* Then */
    assert.deepEqual(next.handoff.dialog?.ticked, ['.env.local']);
});

test('closing the dialog forgets it', () => {
    /* When */
    const state = run(opened(), {type: 'handoffDialogClosed'});

    /* Then */
    assert.equal(state.handoff.dialog, null);
});

// ── The run ──

test('a hand-off runs with its progress lines, in order', () => {
    /* When */
    const state = run(
        opened(),
        {type: 'handoffStarted', localPath: LOCAL, hostKey: HOST.key},
        {type: 'handoffProgress', localPath: LOCAL, line: 'Cloning from origin'},
        {type: 'handoffProgress', localPath: LOCAL, line: 'Applying 2 commits'},
    );

    /* Then */
    assert.deepEqual(runIn(state.handoff, LOCAL), {
        phase: 'running',
        hostKey: HOST.key,
        lines: ['Cloning from origin', 'Applying 2 commits'],
    });
});

test('a hand-off that succeeds keeps its lines and the copy to open', () => {
    /* Given */
    const state = run(
        opened(),
        {type: 'handoffStarted', localPath: LOCAL, hostKey: HOST.key},
        {type: 'handoffProgress', localPath: LOCAL, line: 'Cloning from origin'},
    );

    /* When */
    const next = run(state, {
        type: 'handoffFinished',
        localPath: LOCAL,
        result: {ok: true, copyPath: COPY, reused: false},
    });

    /* Then */
    assert.deepEqual(runIn(next.handoff, LOCAL), {
        phase: 'done',
        hostKey: HOST.key,
        lines: ['Cloning from origin'],
        copyPath: COPY,
        reused: false,
    });
});

test('a hand-off that fails keeps its message, and Retry starts afresh', () => {
    /* Given */
    const failed = run(
        opened(),
        {type: 'handoffStarted', localPath: LOCAL, hostKey: HOST.key},
        {type: 'handoffProgress', localPath: LOCAL, line: 'Cloning from origin'},
        {type: 'handoffFinished', localPath: LOCAL, result: {ok: false, error: 'The clone failed: no access'}},
    );

    /* When */
    const retried = run(failed, {type: 'handoffStarted', localPath: LOCAL, hostKey: HOST.key});

    /* Then */
    assert.deepEqual(runIn(failed.handoff, LOCAL), {
        phase: 'failed',
        hostKey: HOST.key,
        lines: ['Cloning from origin'],
        error: 'The clone failed: no access',
    });
    assert.deepEqual(runIn(retried.handoff, LOCAL), {phase: 'running', hostKey: HOST.key, lines: []});
});

test('a failure without a message still says something', () => {
    /* When */
    const state = run(
        opened(),
        {type: 'handoffStarted', localPath: LOCAL, hostKey: HOST.key},
        {type: 'handoffFinished', localPath: LOCAL, result: {ok: false, error: ''}},
    );

    /* Then */
    const after = runIn(state.handoff, LOCAL);
    assert.equal(after.phase === 'failed' && after.error, 'The hand-off didn’t finish');
});

test('opening the dialog again while it runs keeps the run on screen', () => {
    /* Given */
    const state = run(
        opened(),
        {type: 'handoffStarted', localPath: LOCAL, hostKey: HOST.key},
        {type: 'handoffProgress', localPath: LOCAL, line: 'Cloning from origin'},
        {type: 'handoffDialogClosed'},
    );

    /* When */
    const next = run(state, {type: 'handoffDialogOpened', localPath: LOCAL, host: HOST});

    /* Then */
    assert.equal(runIn(next.handoff, LOCAL).phase, 'running');
});

test('opening the dialog again after a run starts with Hand off', () => {
    /* Given */
    const state = run(
        opened(),
        {type: 'handoffStarted', localPath: LOCAL, hostKey: HOST.key},
        {type: 'handoffFinished', localPath: LOCAL, result: {ok: true, copyPath: COPY, reused: false}},
    );

    /* When */
    const next = run(state, {type: 'handoffDialogOpened', localPath: LOCAL, host: HOST});

    /* Then */
    assert.deepEqual(runIn(next.handoff, LOCAL), {phase: 'idle'});
});

test('progress for a run that isn’t going changes nothing', () => {
    /* Given */
    const state = initialRendererState();

    /* When */
    const next = run(state, {type: 'handoffProgress', localPath: LOCAL, line: 'Cloning'});

    /* Then */
    assert.equal(next, state);
});

// ── Bring back ──

test('Bring back runs with its lines, then names the branch and the worktree', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'bringBackStarted', copyPath: COPY},
        {type: 'bringBackProgress', copyPath: COPY, line: 'Pushing feature/x'},
        {
            type: 'bringBackFinished',
            copyPath: COPY,
            result: {ok: true, worktree: '/Users/me/code/app/.claude/worktrees/x', branch: 'feature/x'},
        },
    );

    /* Then */
    assert.deepEqual(bringBackIn(state.handoff, COPY), {
        phase: 'done',
        lines: ['Pushing feature/x'],
        worktree: '/Users/me/code/app/.claude/worktrees/x',
        branch: 'feature/x',
    });
});

test('Bring back that fails keeps its message', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'bringBackStarted', copyPath: COPY},
        {type: 'bringBackFinished', copyPath: COPY, result: {ok: false, error: 'The push was rejected'}},
    );

    /* Then */
    assert.deepEqual(bringBackIn(state.handoff, COPY), {phase: 'failed', lines: [], error: 'The push was rejected'});
});

// ── Remove copy ──

test('a copy with no work of its own is clean', () => {
    /* When */
    const decision = removeDecision(CLEAN);

    /* Then */
    assert.equal(decision, 'clean');
});

test('a copy with unpushed commits or uncommitted changes is not', () => {
    /* When */
    const unpushed = removeDecision({...CLEAN, unpushed: [{oid: 'a1', subject: 'Fix it'}]});
    const uncommitted = removeDecision({...CLEAN, uncommitted: ['src/a.ts']});

    /* Then */
    assert.equal(unpushed, 'dirty');
    assert.equal(uncommitted, 'dirty');
});

test('a VM that can’t be reached removes nothing', () => {
    /* When */
    const decision = removeDecision(null);

    /* Then */
    assert.equal(decision, 'unreachable');
});

test('a clean copy goes on to the confirm', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'copyRemoveChecking', copyPath: COPY},
        {type: 'copyRemoveChecked', copyPath: COPY, status: CLEAN},
    );

    /* Then */
    assert.deepEqual(removalIn(state.handoff, COPY), {phase: 'confirming'});
});

test('a copy with work lists it before removing', () => {
    /* Given */
    const status: CopyStatus = {...CLEAN, uncommitted: ['src/a.ts']};

    /* When */
    const state = run(initialRendererState(), {type: 'copyRemoveChecked', copyPath: COPY, status});

    /* Then */
    assert.deepEqual(removalIn(state.handoff, COPY), {phase: 'dirty', status});
});

test('an unreachable VM is said, and the copy is kept', () => {
    /* Given */
    const copy = {copyPath: COPY, hostKey: HOST.key, hostLabel: HOST.label};
    const state = run(initialRendererState(), {type: 'handoffCopiesLoaded', localPath: LOCAL, copies: [copy]});

    /* When */
    const next = run(state, {type: 'copyRemoveChecked', copyPath: COPY, status: null});

    /* Then */
    assert.deepEqual(removalIn(next.handoff, COPY), {phase: 'unreachable'});
    assert.deepEqual(copiesIn(next.handoff, LOCAL), [copy]);
});

test('a removed copy leaves its local project’s list and forgets its origin', () => {
    /* Given */
    const copy = {copyPath: COPY, hostKey: HOST.key, hostLabel: HOST.label};
    const state = run(
        initialRendererState(),
        {type: 'handoffCopiesLoaded', localPath: LOCAL, copies: [copy]},
        {type: 'handoffOriginLoaded', copyPath: COPY, origin: LOCAL},
        {type: 'copyRemoving', copyPath: COPY},
    );

    /* When */
    const next = run(state, {type: 'copyRemoveFinished', copyPath: COPY, result: {ok: true}});

    /* Then */
    assert.deepEqual(copiesIn(next.handoff, LOCAL), []);
    assert.equal(originIn(next.handoff, COPY), null);
    assert.deepEqual(removalIn(next.handoff, COPY), {phase: 'removed'});
});

test('a removal that fails keeps the copy and says why', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'copyRemoving', copyPath: COPY},
        {type: 'copyRemoveFinished', copyPath: COPY, result: {ok: false, error: 'Permission denied'}},
    );

    /* Then */
    assert.deepEqual(removalIn(state.handoff, COPY), {phase: 'failed', error: 'Permission denied'});
});

test('Bring back first clears the list, so Remove asks again afterwards', () => {
    /* Given */
    const state = run(initialRendererState(), {
        type: 'copyRemoveChecked',
        copyPath: COPY,
        status: {...CLEAN, uncommitted: ['src/a.ts']},
    });

    /* When */
    const next = run(state, {type: 'copyRemoveCancelled', copyPath: COPY}, {type: 'bringBackStarted', copyPath: COPY});

    /* Then */
    assert.deepEqual(removalIn(next.handoff, COPY), {phase: 'idle'});
    assert.equal(bringBackIn(next.handoff, COPY).phase, 'running');
});

// ── Schedules (stage 5) ──

const ON_MAC: ScheduleLocation = {localPath: LOCAL, runsOn: {kind: 'mac'}, count: 2};
const ON_COPY: ScheduleLocation = {localPath: LOCAL, runsOn: {kind: 'vm', copyPath: COPY}, count: 2};

test('the dialog opens with the schedules ticked to run on the VM', () => {
    /* When */
    const state = opened();

    /* Then */
    assert.equal(state.handoff.dialog?.schedulesOnVm, true);
});

test('the schedules checkbox unticks and ticks again', () => {
    /* When */
    const unticked = run(opened(), {type: 'handoffSchedulesToggled'});
    const ticked = run(unticked, {type: 'handoffSchedulesToggled'});

    /* Then */
    assert.equal(unticked.handoff.dialog?.schedulesOnVm, false);
    assert.equal(ticked.handoff.dialog?.schedulesOnVm, true);
});

test('opening the dialog again starts it ticked again', () => {
    /* Given */
    const unticked = run(opened(), {type: 'handoffSchedulesToggled'}, {type: 'handoffDialogClosed'});

    /* When */
    const state = run(unticked, {type: 'handoffDialogOpened', localPath: LOCAL, host: HOST});

    /* Then */
    assert.equal(state.handoff.dialog?.schedulesOnVm, true);
});

test('each page knows where its project’s schedules run once main says', () => {
    /* When */
    const state = run(initialRendererState(), {type: 'schedulesLoaded', projectPath: LOCAL, location: ON_MAC});

    /* Then */
    assert.deepEqual(schedulesIn(state.handoff, LOCAL), {location: ON_MAC, moving: false, error: null});
    assert.deepEqual(schedulesIn(state.handoff, COPY), {location: null, moving: false, error: null});
});

test('a move that fails keeps them where they were and says why', () => {
    /* Given */
    const state = run(initialRendererState(), {type: 'schedulesLoaded', projectPath: LOCAL, location: ON_MAC});

    /* When */
    const moving = run(state, {type: 'schedulesMoving', projectPath: LOCAL});
    const failed = run(moving, {
        type: 'schedulesMoved',
        projectPath: LOCAL,
        answer: {error: 'Couldn’t reach the VM'},
    });

    /* Then */
    assert.equal(schedulesIn(moving.handoff, LOCAL).moving, true);
    assert.deepEqual(schedulesIn(failed.handoff, LOCAL), {
        location: ON_MAC,
        moving: false,
        error: 'Couldn’t reach the VM',
    });
});

test('a move from one page shows on the other page of the same project too', () => {
    /* Given */
    const state = run(
        initialRendererState(),
        {type: 'schedulesLoaded', projectPath: LOCAL, location: ON_MAC},
        {type: 'schedulesLoaded', projectPath: COPY, location: ON_MAC},
    );

    /* When */
    const moved = run(state, {type: 'schedulesMoved', projectPath: COPY, answer: ON_COPY});

    /* Then */
    assert.deepEqual(schedulesIn(moved.handoff, COPY), {location: ON_COPY, moving: false, error: null});
    assert.deepEqual(schedulesIn(moved.handoff, LOCAL).location, ON_COPY);
});
