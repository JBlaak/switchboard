/**
 * Project hand-off in the renderer's store (#276 stage 2): the hosts, a
 * project's copies and a copy's origin, the dialog's preview and ticks, a
 * hand-off's progress, success and failure, Bring back, and the decision
 * Remove copy makes from the copy's status.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {bringBackIn, copiesIn, originIn, removalIn, removeDecision, runIn} from '../src/renderer/state/handoff-slice';
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
    assert.deepEqual(state.handoff.dialog, {localPath: LOCAL, host: HOST, preview: {phase: 'loading'}, ticked: []});
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
