/**
 * A VM session's Bring back in the renderer (#276): where the button shows,
 * the dialog's lines and its question about a branch that is here already,
 * and the run's waiting, running, existing, done, failed and cancelled states.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {canBringBackSession, rowButtons} from '../src/renderer/state/session-list-layout';
import {bringBackRunIn} from '../src/renderer/state/session-bring-back-slice';
import {isVmCopyIn} from '../src/renderer/state/agent-host-slice';
import {
    bringBackLines,
    bringBackPhaseAnswer,
    bringBackRunView,
    deleteLine,
    existingLine,
} from '../src/renderer/ui/dialogs/session-bring-back-view';
import {buildProjectList} from '../src/domain/project/project-list';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {SessionRow} from '../src/domain/session/session';
import type {ExistingBranch} from '../src/domain/project/branch-worktree';
import type {SessionBringBackPreview} from '../src/application/services/session-bring-back';

const ID = 's1';
const COPY = 'ssh://dev@buildbox/~/projects/app';
const LOCAL = '/Users/me/code/app';
const WORKTREE = `${LOCAL}/.claude/worktrees/fix-login`;
const EXISTING: ExistingBranch = {
    branch: 'fix-login',
    worktreePath: WORKTREE,
    main: false,
    changedFiles: 2,
    ahead: 1,
    sessionId: null,
};
const PREVIEW: SessionBringBackPreview = {
    copyPath: COPY,
    localPath: LOCAL,
    branch: 'fix-login',
    worktree: WORKTREE,
    existing: null,
    uncommitted: 0,
    busy: false,
};

function session(over: Partial<SessionRow> = {}): SessionRow {
    return {
        sessionId: ID,
        projectPath: COPY,
        folder: '',
        summary: 'Remote Claude',
        firstPrompt: '',
        created: '2026-11-10T10:00:00.000Z',
        modified: '2026-11-10T10:00:00.000Z',
        messageCount: 0,
        slug: null,
        name: null,
        starred: 0,
        archived: 0,
        type: 'remote',
        remoteKind: 'claude',
        ...over,
    } as SessionRow;
}

function run(events: RendererEvent[], state: RendererState = initialRendererState()): RendererState {
    return events.reduce((next, event) => rootReducer(next, event), state);
}

// ── Where Bring back shows ──

test('Bring back shows on a Claude session on a VM copy of a local project', () => {
    /* When */
    const buttons = rowButtons(session(), {vm: true, copy: true});

    /* Then */
    assert.equal(buttons.bringBack, true);
});

test('Bring back does not show on a VM project that is no copy, a VM terminal, or a local session', () => {
    /* When */
    const notACopy = canBringBackSession(session(), {vm: true, copy: false});
    const terminal = canBringBackSession(session({remoteKind: 'shell'}), {vm: true, copy: true});
    const local = canBringBackSession(session({type: undefined, projectPath: LOCAL}), {vm: false, copy: false});

    /* Then */
    assert.deepEqual([notACopy, terminal, local], [false, false, false]);
});

test('a VM copy is known as one from the project list', () => {
    /* Given */
    const projects = buildProjectList({
        cached: [],
        meta: new Map(),
        hiddenProjects: new Set(),
        knownProjectPaths: [],
        activeTerminals: [],
        remoteProjects: [
            {
                user: 'dev',
                host: 'buildbox',
                port: 22,
                dir: '~/projects/app',
                agent: {version: '2.17.0', installedAt: ''},
                copyOf: LOCAL,
            },
        ],
        pinnedPlans: [],
        pinnedIssuePlans: [],
        showArchived: false,
    });

    /* When */
    const state = run([
        {
            type: 'agentProjectsLoaded',
            projectPaths: projects.filter((p) => p.agent).map((p) => p.projectPath),
            copyPaths: projects.filter((p) => p.agent && p.copyOf).map((p) => p.projectPath),
        },
    ]);

    /* Then */
    assert.equal(projects[0].copyOf, LOCAL);
    assert.equal(isVmCopyIn(state.agentHost, COPY), true);
    assert.equal(isVmCopyIn(state.agentHost, LOCAL), false);
});

// ── The dialog's lines ──

test('what comes back names the branch and where it lands', () => {
    /* When */
    const fresh = bringBackLines(PREVIEW);
    const into = bringBackLines({...PREVIEW, existing: EXISTING});

    /* Then */
    assert.deepEqual(
        fresh.map((line) => line.text + (line.code ?? '')),
        [
            'The conversation, resumed on this Mac in the same row',
            'The branch fix-login',
            `Into a new worktree at ${WORKTREE}`,
        ],
    );
    assert.equal(into[2].text, 'Into the worktree at ');
});

test('an existing branch says where it is and what is on it, and deleting says what goes', () => {
    /* When */
    const here = existingLine(EXISTING);
    const main = existingLine({...EXISTING, worktreePath: LOCAL, main: true, changedFiles: 0, ahead: 0});
    const gone = deleteLine(EXISTING);

    /* Then */
    assert.equal(
        here,
        'fix-login is in a worktree on this Mac already, with 2 uncommitted files and 1 commit not on the default branch.',
    );
    assert.equal(main, 'fix-login is checked out in the main checkout already.');
    assert.match(
        gone,
        new RegExp(
            `^Delete the worktree at ${WORKTREE} and its branch, with 2 uncommitted files and 1 commit not on the default branch,`,
        ),
    );
});

// ── The run ──

test('a run goes waiting, running, done, keeping its lines', () => {
    /* Given */
    const opened = run([{type: 'bringBackDialogOpened', sessionId: ID, name: 'Fix login'}]);

    /* When */
    const waiting = run([{type: 'bringBackStartedRun', sessionId: ID, busy: true}], opened);
    const running = run(
        [{type: 'sessionBringBackPhase', sessionId: ID, phase: {kind: 'running', line: 'Fetching fix-login'}}],
        waiting,
    );
    const done = run(
        [{type: 'sessionBringBackPhase', sessionId: ID, phase: {kind: 'done', projectPath: WORKTREE}}],
        running,
    );

    /* Then */
    assert.equal(bringBackRunIn(waiting.sessionBringBack, ID).phase, 'waiting');
    assert.equal(bringBackRunView(bringBackRunIn(waiting.sessionBringBack, ID)).secondary.does, 'cancel');
    assert.deepEqual(bringBackRunView(bringBackRunIn(running.sessionBringBack, ID)).lines, ['Fetching fix-login']);
    const view = bringBackRunView(bringBackRunIn(done.sessionBringBack, ID));
    assert.equal(view.done, `Continues on this Mac in ${WORKTREE}`);
    assert.equal(view.primary, null);
});

test('a run that finds the branch here asks about it, with no Bring back button', () => {
    /* Given */
    const started = run([
        {type: 'bringBackDialogOpened', sessionId: ID, name: ''},
        {type: 'bringBackStartedRun', sessionId: ID, busy: false},
    ]);

    /* When */
    const asked = run(
        [{type: 'bringBackFinishedRun', sessionId: ID, phase: {kind: 'existing', existing: EXISTING}}],
        started,
    );

    /* Then */
    const view = bringBackRunView(bringBackRunIn(asked.sessionBringBack, ID));
    assert.deepEqual(view.existing, EXISTING);
    assert.equal(view.primary, null);
});

test('a failed run offers Retry; a cancelled one is forgotten and its dialog closes', () => {
    /* Given */
    const started = run([
        {type: 'dialogOpened', request: {kind: 'bringBackSession', sessionId: ID}},
        {type: 'bringBackDialogOpened', sessionId: ID, name: ''},
        {type: 'bringBackStartedRun', sessionId: ID, busy: true},
    ]);

    /* When */
    const failed = run(
        [{type: 'sessionBringBackPhase', sessionId: ID, phase: {kind: 'failed', error: 'Could not reach the VM'}}],
        started,
    );
    const cancelled = run([{type: 'sessionBringBackPhase', sessionId: ID, phase: {kind: 'cancelled'}}], started);

    /* Then */
    const view = bringBackRunView(bringBackRunIn(failed.sessionBringBack, ID));
    assert.equal(view.error, 'Could not reach the VM');
    assert.equal(view.primary?.label, 'Retry');
    assert.equal(bringBackRunIn(cancelled.sessionBringBack, ID).phase, 'idle');
    assert.equal(cancelled.dialog.open, null);
});

test('a phase that main answered in a broken shape reads as a failure', () => {
    /* When */
    const broken = bringBackPhaseAnswer({kind: 'existing', existing: {branch: 1}});
    const done = bringBackPhaseAnswer({kind: 'done', projectPath: WORKTREE});

    /* Then */
    assert.equal(broken.kind, 'failed');
    assert.deepEqual(done, {kind: 'done', projectPath: WORKTREE});
});
