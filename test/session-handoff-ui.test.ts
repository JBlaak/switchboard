/**
 * Session hand-off in the renderer (#276 stage 3): where Hand off to… shows,
 * the dialog's lines in session mode, the run's waiting, running, done,
 * failed and cancelled states, and the row's marker.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {canHandOffSession, rowButtons} from '../src/renderer/state/session-list-layout';
import {inFlight, sessionRunIn} from '../src/renderer/state/session-handoff-slice';
import {
    busyNote,
    phaseAnswer,
    rowHandoffMarker,
    sessionCarriedLines,
    sessionRunView,
    WAITING_LINE,
} from '../src/renderer/ui/dialogs/session-handoff-view';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {SessionRow} from '../src/domain/session/session';
import type {HandoffHost} from '../src/application/services/project-handoff';
import type {SessionHandoffPreview} from '../src/application/services/session-handoff';

const ID = 's1';
const COPY = 'ssh://dev@buildbox/home/dev/projects/app';
const HOST: HandoffHost = {key: 'dev@buildbox:22', label: 'dev@buildbox'};
const PREVIEW: SessionHandoffPreview = {
    localPath: '/Users/me/code/app',
    worktree: null,
    branch: 'feature/x',
    unpushed: 2,
    uncommitted: 0,
    candidates: [
        {path: '.env', size: 312, ticked: true},
        {path: '.env.local', size: 120, ticked: false},
    ],
    busy: false,
};

function session(extra: Partial<SessionRow> = {}): SessionRow {
    return {
        sessionId: ID,
        summary: 'Session',
        firstPrompt: '',
        projectPath: '/Users/me/code/app',
        created: '2026-11-01T00:00:00.000Z',
        modified: '2026-11-01T00:00:00.000Z',
        messageCount: 1,
        name: null,
        starred: 0,
        archived: 0,
        ...extra,
    };
}

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(preview: SessionHandoffPreview = PREVIEW): RendererState {
    return run(
        initialRendererState(),
        {type: 'dialogOpened', request: {kind: 'handOffSession', sessionId: ID, host: HOST}},
        {type: 'sessionHandoffDialogOpened', sessionId: ID, host: HOST, name: 'Fix the build'},
        {type: 'sessionHandoffPreviewLoaded', sessionId: ID, answer: preview},
    );
}

function started({busy = false, running = true} = {}): RendererState {
    return run(opened(), {type: 'sessionHandoffStarted', sessionId: ID, host: HOST, busy, running});
}

// ── Where Hand off to… shows ──

test('a local Claude session offers Hand off to… once there is a host', () => {
    /* When */
    const offered = canHandOffSession(session(), 1);

    /* Then */
    assert.equal(offered, true);
});

test('a local Claude session offers no hand-off without a host', () => {
    /* When */
    const offered = canHandOffSession(session(), 0);

    /* Then */
    assert.equal(offered, false);
});

test('a session list row never offers Hand off to…, even with a host', () => {
    /* When */
    const buttons = rowButtons(session());

    /* Then */
    assert.equal('handOff' in buttons, false);
});

test('a session read off disk as Claude is offered the hand-off too', () => {
    /* Given */
    const claude = session({type: 'claude'});

    /* When */
    const offered = canHandOffSession(claude, 2);

    /* Then */
    assert.equal(offered, true);
});

test('a terminal is never handed off', () => {
    /* When */
    const offered = canHandOffSession(session({type: 'terminal'}), 1);

    /* Then */
    assert.equal(offered, false);
});

test('a session on an ssh remote is never handed off', () => {
    /* Given */
    const remote = session({projectPath: 'ssh://me@box/app', type: 'remote', remoteKind: 'claude'});

    /* When */
    const offered = canHandOffSession(remote, 1);

    /* Then */
    assert.equal(offered, false);
});

test('a session already on a VM is never handed off', () => {
    /* Given */
    const vm = session({projectPath: COPY, type: 'remote', remoteKind: 'claude'});

    /* When */
    const offered = canHandOffSession(vm, 1);

    /* Then */
    assert.equal(offered, false);
});

test('a row under a remote project path is never handed off, whatever its type says', () => {
    /* When */
    const offered = canHandOffSession(session({projectPath: COPY}), 1);

    /* Then */
    assert.equal(offered, false);
});

// ── The dialog's lines ──

test('the dialog lists the conversation, the branch and what only this Mac has', () => {
    /* When */
    const lines = sessionCarriedLines(PREVIEW);

    /* Then */
    assert.deepEqual(lines, [
        {text: 'The conversation, resumed on the VM'},
        {text: 'Branch ', code: 'feature/x'},
        {text: '2 commits not on origin'},
    ]);
});

test('a session in a worktree says which one, after its branch', () => {
    /* Given */
    const preview = {...PREVIEW, worktree: 'fix-build', unpushed: 0, uncommitted: 1};

    /* When */
    const lines = sessionCarriedLines(preview);

    /* Then */
    assert.deepEqual(lines, [
        {text: 'The conversation, resumed on the VM'},
        {text: 'Branch ', code: 'feature/x'},
        {text: 'In worktree ', code: 'fix-build'},
        {text: '1 uncommitted change'},
    ]);
});

test('a session mid-turn notes that the hand-off waits for the turn to end', () => {
    /* Given */
    const preview = {...PREVIEW, busy: true};

    /* When */
    const note = busyNote(preview, sessionRunIn(opened(preview).sessionHandoff, ID));

    /* Then */
    assert.equal(note, 'Claude is mid-turn. The hand-off starts when this turn ends.');
});

test('an idle session has no busy note', () => {
    /* When */
    const note = busyNote(PREVIEW, sessionRunIn(opened().sessionHandoff, ID));

    /* Then */
    assert.equal(note, null);
});

test('the busy note gives way once the hand-off is waiting', () => {
    /* Given */
    const preview = {...PREVIEW, busy: true};

    /* When */
    const note = busyNote(preview, sessionRunIn(started({busy: true}).sessionHandoff, ID));

    /* Then */
    assert.equal(note, null);
});

test('the preview ticks the files ticked last time', () => {
    /* When */
    const state = opened();

    /* Then */
    assert.deepEqual(state.sessionHandoff.dialog?.ticked, ['.env']);
    assert.equal(state.sessionHandoff.dialog?.name, 'Fix the build');
});

test('a file can be ticked and unticked', () => {
    /* When */
    const state = run(
        opened(),
        {type: 'sessionHandoffFileToggled', path: '.env.local'},
        {type: 'sessionHandoffFileToggled', path: '.env'},
    );

    /* Then */
    assert.deepEqual(state.sessionHandoff.dialog?.ticked, ['.env.local']);
});

test('a session that cannot be handed off shows why', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'sessionHandoffDialogOpened', sessionId: ID, host: HOST, name: ''},
        {type: 'sessionHandoffPreviewLoaded', sessionId: ID, answer: {error: 'No origin to clone from'}},
    );

    /* Then */
    assert.deepEqual(state.sessionHandoff.dialog?.preview, {phase: 'error', error: 'No origin to clone from'});
});

test('before it starts the dialog offers Hand off and Cancel, and the files can be ticked', () => {
    /* When */
    const view = sessionRunView(sessionRunIn(opened().sessionHandoff, ID));

    /* Then */
    assert.deepEqual(view.primary, {label: 'Hand off', disabled: false, does: 'handOff'});
    assert.deepEqual(view.secondary, {label: 'Cancel', disabled: false, does: 'close'});
    assert.equal(view.editable, true);
});

// ── Waiting ──

test('a busy session starts out waiting for its turn to end', () => {
    /* When */
    const state = started({busy: true});

    /* Then */
    assert.equal(sessionRunIn(state.sessionHandoff, ID).phase, 'waiting');
});

test('while it waits the dialog says so, and Cancel calls the hand-off off', () => {
    /* Given */
    const state = run(started(), {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'waiting'}});

    /* When */
    const view = sessionRunView(sessionRunIn(state.sessionHandoff, ID));

    /* Then */
    assert.equal(view.status, WAITING_LINE);
    assert.equal(view.status, 'Waiting for the turn to end…');
    assert.deepEqual(view.secondary, {label: 'Cancel', disabled: false, does: 'cancel'});
    assert.equal(view.primary?.disabled, true);
    assert.equal(view.editable, false);
});

test('a second Hand off while one waits starts nothing new', () => {
    /* Given */
    const waiting = started({busy: true});

    /* When */
    const state = run(waiting, {type: 'sessionHandoffStarted', sessionId: ID, host: HOST, busy: false, running: true});

    /* Then */
    assert.equal(state.sessionHandoff, waiting.sessionHandoff);
});

// ── Running ──

test('the progress lines come in as it runs', () => {
    /* When */
    const state = run(
        started({busy: true}),
        {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'running', line: 'Updating the copy'}},
        {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'running', line: 'Copying the transcript'}},
    );

    /* Then */
    const view = sessionRunView(sessionRunIn(state.sessionHandoff, ID));
    assert.deepEqual(view.lines, ['Updating the copy', 'Copying the transcript']);
    assert.equal(view.status, null);
    assert.deepEqual(view.primary, {label: 'Handing off…', disabled: true, does: 'handOff'});
    assert.deepEqual(view.secondary, {label: 'Close', disabled: false, does: 'close'});
});

test('closing the dialog leaves the hand-off running', () => {
    /* When */
    const state = run(started(), {type: 'sessionHandoffDialogClosed'});

    /* Then */
    assert.equal(state.sessionHandoff.dialog, null);
    assert.equal(inFlight(sessionRunIn(state.sessionHandoff, ID)), true);
});

// ── Done ──

test('done says where the session continues', () => {
    /* When */
    const state = run(started(), {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'done', copyPath: COPY}});

    /* Then */
    const runState = sessionRunIn(state.sessionHandoff, ID);
    const view = sessionRunView(runState);
    assert.equal(runState.phase === 'done' && runState.copyPath, COPY);
    assert.equal(view.done, 'Continues on dev@buildbox');
    assert.equal(view.primary, null);
    assert.deepEqual(view.secondary, {label: 'Close', disabled: false, does: 'close'});
});

test('the answer after the done push changes nothing', () => {
    /* Given */
    const done = run(started(), {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'done', copyPath: COPY}});

    /* When */
    const state = run(done, {type: 'sessionHandoffFinished', sessionId: ID, phase: {kind: 'done', copyPath: COPY}});

    /* Then */
    assert.equal(state.sessionHandoff, done.sessionHandoff);
});

test('the answer finishes a run whose last push was lost', () => {
    /* When */
    const state = run(started(), {
        type: 'sessionHandoffFinished',
        sessionId: ID,
        phase: {kind: 'done', copyPath: COPY},
    });

    /* Then */
    assert.equal(sessionRunIn(state.sessionHandoff, ID).phase, 'done');
});

test('opening the dialog again forgets a hand-off that ended', () => {
    /* Given */
    const done = run(started(), {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'done', copyPath: COPY}});

    /* When */
    const state = run(done, {type: 'sessionHandoffDialogOpened', sessionId: ID, host: HOST, name: ''});

    /* Then */
    assert.equal(sessionRunIn(state.sessionHandoff, ID).phase, 'idle');
});

// ── Failed ──

test('a failure before the session stopped says it is still running here', () => {
    /* When */
    const state = run(started(), {
        type: 'sessionHandoffPhase',
        sessionId: ID,
        phase: {kind: 'failed', error: 'Couldn’t reach the VM'},
    });

    /* Then */
    const view = sessionRunView(sessionRunIn(state.sessionHandoff, ID));
    assert.equal(view.error, 'Couldn’t reach the VM');
    assert.equal(view.errorNote, 'The session wasn’t moved and is still running here.');
    assert.deepEqual(view.primary, {label: 'Retry', disabled: false, does: 'handOff'});
});

test('a failure after the session stopped says it stopped here', () => {
    /* When */
    const state = run(
        started(),
        {type: 'processExited', sessionId: ID, exitCode: 0},
        {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'failed', error: 'The resume failed'}},
    );

    /* Then */
    const view = sessionRunView(sessionRunIn(state.sessionHandoff, ID));
    assert.equal(view.errorNote, 'The session wasn’t moved. It stopped here; open it to resume.');
});

test('a failure of a session that wasn’t running only says it wasn’t moved', () => {
    /* When */
    const state = run(started({running: false}), {
        type: 'sessionHandoffPhase',
        sessionId: ID,
        phase: {kind: 'failed', error: 'No origin'},
    });

    /* Then */
    assert.equal(sessionRunView(sessionRunIn(state.sessionHandoff, ID)).errorNote, 'The session wasn’t moved.');
});

test('a failure without a message still says it didn’t finish', () => {
    /* When */
    const state = run(started(), {type: 'sessionHandoffFinished', sessionId: ID, phase: phaseAnswer({ok: false})});

    /* Then */
    assert.equal(sessionRunView(sessionRunIn(state.sessionHandoff, ID)).error, 'The hand-off didn’t finish');
});

test('main’s error envelope reads as a failure with its message', () => {
    /* When */
    const phase = phaseAnswer({ok: false, error: 'Session hand-off isn’t available in this build'});

    /* Then */
    assert.deepEqual(phase, {kind: 'failed', error: 'Session hand-off isn’t available in this build'});
});

// ── Cancelled ──

test('a cancelled hand-off is forgotten and its dialog closes quietly', () => {
    /* When */
    const state = run(started({busy: true}), {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'cancelled'}});

    /* Then */
    assert.equal(sessionRunIn(state.sessionHandoff, ID).phase, 'idle');
    assert.equal(state.sessionHandoff.dialog, null);
    assert.equal(state.dialog.open, null);
});

test('a cancel for another session leaves the open dialog alone', () => {
    /* When */
    const state = run(started({busy: true}), {
        type: 'sessionHandoffPhase',
        sessionId: 'other',
        phase: {kind: 'cancelled'},
    });

    /* Then */
    assert.equal(state.dialog.open?.kind, 'handOffSession');
    assert.equal(sessionRunIn(state.sessionHandoff, ID).phase, 'waiting');
});

// ── The row's marker ──

test('the row says Waiting… while the hand-off waits for the turn to end', () => {
    /* When */
    const marker = rowHandoffMarker(sessionRunIn(started({busy: true}).sessionHandoff, ID));

    /* Then */
    assert.equal(marker, 'Waiting…');
});

test('the row says Handing off… while it runs, with the dialog closed', () => {
    /* Given */
    const state = run(started(), {type: 'sessionHandoffDialogClosed'});

    /* When */
    const marker = rowHandoffMarker(sessionRunIn(state.sessionHandoff, ID));

    /* Then */
    assert.equal(marker, 'Handing off…');
});

test('the row has no marker once the hand-off is done or failed, or with none', () => {
    /* Given */
    const done = run(started(), {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'done', copyPath: COPY}});
    const failed = run(started(), {type: 'sessionHandoffPhase', sessionId: ID, phase: {kind: 'failed', error: 'x'}});

    /* When */
    const markers = [done, failed, initialRendererState()].map((s) =>
        rowHandoffMarker(sessionRunIn(s.sessionHandoff, ID)),
    );

    /* Then */
    assert.deepEqual(markers, [null, null, null]);
});

test('a re-keyed session keeps its hand-off', () => {
    /* When */
    const state = run(started({busy: true}), {type: 'sessionForked', oldId: ID, newId: 's2'});

    /* Then */
    assert.equal(sessionRunIn(state.sessionHandoff, 's2').phase, 'waiting');
    assert.equal(sessionRunIn(state.sessionHandoff, ID).phase, 'idle');
    assert.equal(state.sessionHandoff.dialog?.sessionId, 's2');
});
