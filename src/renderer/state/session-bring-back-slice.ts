/**
 * A VM session's Bring back as the renderer shows it (#276): the Bring back
 * dialog for one session, with its preview, and each session's Bring back
 * while it waits for the turn to end, runs, asks about a branch that is here
 * already, and finishes.
 *
 * A run is kept per session rather than in the dialog, as a hand-off's is, so
 * closing the dialog leaves the run going and opening it again shows it. A
 * cancelled run is forgotten, and its dialog closes.
 *
 * The events are declared here, like the session hand-off ones; `events.ts`
 * folds them into the union. The phases are main's pushes and live there.
 */
import {movedEntry, withEntry, withoutEntry} from './records';
import type {ExistingBranch} from '../../domain/project/branch-worktree';
import type {SessionBringBackPhase, SessionBringBackPreview} from '../../application/services/session-bring-back';
import type {IdRecord} from './records';
import type {RendererEvent} from './events';

export type SessionBringBackEvent =
    /** Bring back was pressed on a session; `name` is what its row says. */
    | {type: 'bringBackDialogOpened'; sessionId: string; name: string}
    | {type: 'bringBackPreviewLoaded'; sessionId: string; answer: SessionBringBackPreview | {error: string}}
    | {type: 'bringBackDialogClosed'}
    /** Bring back, Update it, Delete and recreate or Retry was pressed; `busy`: it starts out waiting. */
    | {type: 'bringBackStartedRun'; sessionId: string; busy: boolean}
    /** What the Bring back call answered, once it returned. */
    | {type: 'bringBackFinishedRun'; sessionId: string; phase: SessionBringBackPhase};

export type BringBackPreviewState =
    | {readonly phase: 'loading'}
    | {readonly phase: 'ok'; readonly preview: SessionBringBackPreview}
    | {readonly phase: 'error'; readonly error: string};

export interface BringBackDialogView {
    readonly sessionId: string;
    /** The session's name, as its row shows it. */
    readonly name: string;
    readonly preview: BringBackPreviewState;
}

export type BringBackRunState =
    | {readonly phase: 'idle'}
    | {readonly phase: 'waiting'; readonly lines: readonly string[]}
    | {readonly phase: 'running'; readonly lines: readonly string[]}
    /** The branch turned out to be here already; nothing was changed, and the dialog asks what to do. */
    | {readonly phase: 'existing'; readonly lines: readonly string[]; readonly existing: ExistingBranch}
    | {readonly phase: 'done'; readonly lines: readonly string[]; readonly projectPath: string}
    | {readonly phase: 'failed'; readonly lines: readonly string[]; readonly error: string};

export interface SessionBringBackState {
    readonly dialog: BringBackDialogView | null;
    /** sessionId → its Bring back. */
    readonly runs: IdRecord<BringBackRunState>;
}

export const initialSessionBringBackState: SessionBringBackState = {dialog: null, runs: {}};

const IDLE: BringBackRunState = {phase: 'idle'};

/** How many progress lines are kept. */
const MAX_LINES = 200;

export function sessionBringBackReducer(state: SessionBringBackState, event: RendererEvent): SessionBringBackState {
    switch (event.type) {
        case 'bringBackDialogOpened': {
            const run = bringBackRunIn(state, event.sessionId);
            return {
                dialog: {sessionId: event.sessionId, name: event.name, preview: {phase: 'loading'}},
                // A run still going stays on screen; one that ended is forgotten.
                runs: bringBackInFlight(run) ? state.runs : withoutEntry(state.runs, event.sessionId),
            };
        }

        case 'bringBackPreviewLoaded': {
            const dialog = state.dialog;
            if (!dialog || dialog.sessionId !== event.sessionId) return state;
            const preview: BringBackPreviewState =
                'error' in event.answer
                    ? {phase: 'error', error: event.answer.error}
                    : {phase: 'ok', preview: event.answer};
            return {...state, dialog: {...dialog, preview}};
        }

        case 'bringBackDialogClosed':
            return state.dialog ? {...state, dialog: null} : state;

        case 'bringBackStartedRun': {
            if (bringBackInFlight(bringBackRunIn(state, event.sessionId))) return state;
            const next: BringBackRunState = {phase: event.busy ? 'waiting' : 'running', lines: []};
            return {...state, runs: withEntry(state.runs, event.sessionId, next)};
        }

        case 'sessionBringBackPhase':
            return withPhase(state, event.sessionId, event.phase);

        // The answer repeats the last phase main pushed; it only matters when that push was lost.
        case 'bringBackFinishedRun':
            return bringBackInFlight(bringBackRunIn(state, event.sessionId))
                ? withPhase(state, event.sessionId, event.phase)
                : state;

        default:
            return state;
    }
}

function withPhase(
    state: SessionBringBackState,
    sessionId: string,
    phase: SessionBringBackPhase,
): SessionBringBackState {
    const run = bringBackRunIn(state, sessionId);
    // A phase for a Bring back this window didn't start (it was reloaded since) has nothing to add to.
    if (run.phase === 'idle') return state;
    const {lines} = run;
    const set = (next: BringBackRunState) => ({...state, runs: withEntry(state.runs, sessionId, next)});
    switch (phase.kind) {
        case 'waiting':
            return set({phase: 'waiting', lines});
        case 'running':
            return set({phase: 'running', lines: phase.line ? [...lines, phase.line].slice(-MAX_LINES) : lines});
        case 'existing':
            return set({phase: 'existing', lines, existing: phase.existing});
        case 'done':
            return set({phase: 'done', lines, projectPath: phase.projectPath});
        case 'failed':
            return set({phase: 'failed', lines, error: phase.error || 'The Bring back didn’t finish'});
        case 'cancelled':
            return {
                dialog: state.dialog?.sessionId === sessionId ? null : state.dialog,
                runs: withoutEntry(state.runs, sessionId),
            };
    }
}

/** A re-keyed session keeps its Bring back, and its dialog. */
export function rekeySessionBringBack(
    state: SessionBringBackState,
    oldId: string,
    newId: string,
): SessionBringBackState {
    const runs = movedEntry(state.runs, oldId, newId);
    const dialog = state.dialog?.sessionId === oldId ? {...state.dialog, sessionId: newId} : state.dialog;
    return runs === state.runs && dialog === state.dialog ? state : {dialog, runs};
}

// ── What the surfaces read ──

export function bringBackRunIn(state: SessionBringBackState, sessionId: string): BringBackRunState {
    return state.runs[sessionId] ?? IDLE;
}

/** Waiting for its turn to end, or running. */
export function bringBackInFlight(run: BringBackRunState): boolean {
    return run.phase === 'waiting' || run.phase === 'running';
}
