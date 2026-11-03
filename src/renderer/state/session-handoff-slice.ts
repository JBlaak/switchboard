/**
 * Session hand-off as the renderer shows it (#276 stage 3): the Hand off
 * dialog for one session, with its preview and ticks, and each session's
 * hand-off while it waits for the turn to end, runs, and finishes.
 *
 * A run is kept per session rather than in the dialog, so closing the dialog
 * leaves the row's "Waiting…" or "Handing off…" marker, and opening it again
 * shows the same run. A cancelled run is forgotten, and its dialog closes.
 *
 * A failed run says whether the local session is still running. The phase
 * doesn't say, so the run notes whether the session was running when it
 * started and whether its process exited since: a failure after the exit
 * left the session stopped here.
 *
 * The events are declared here rather than in `events.ts`, like the project
 * hand-off ones; `events.ts` folds them into the union. The phases are main's
 * pushes and live there.
 */
import {movedEntry, withEntry, withoutEntry} from './records';
import type {HandoffHost} from '../../application/services/project-handoff';
import type {SessionHandoffPhase, SessionHandoffPreview} from '../../application/services/session-handoff';
import type {IdRecord} from './records';
import type {RendererEvent} from './events';

export type SessionHandoffEvent =
    /** Hand off to… was pressed on a session, with this host picked; `name` is what its row says. */
    | {type: 'sessionHandoffDialogOpened'; sessionId: string; host: HandoffHost; name: string}
    | {type: 'sessionHandoffPreviewLoaded'; sessionId: string; answer: SessionHandoffPreview | {error: string}}
    /** One of the ignored files was ticked or unticked. */
    | {type: 'sessionHandoffFileToggled'; path: string}
    | {type: 'sessionHandoffDialogClosed'}
    /**
     * Hand off or Retry was pressed. `busy`: the preview said Claude is
     * mid-turn, so it starts out waiting. `running`: the session had a live
     * process here.
     */
    | {type: 'sessionHandoffStarted'; sessionId: string; host: HandoffHost; busy: boolean; running: boolean}
    /** What the hand-off call answered, once it returned. */
    | {type: 'sessionHandoffFinished'; sessionId: string; phase: SessionHandoffPhase};

export type SessionPreviewState =
    | {readonly phase: 'loading'}
    | {readonly phase: 'ok'; readonly preview: SessionHandoffPreview}
    | {readonly phase: 'error'; readonly error: string};

export interface SessionHandoffDialogView {
    readonly sessionId: string;
    readonly host: HandoffHost;
    /** The session's name, as its row shows it. */
    readonly name: string;
    readonly preview: SessionPreviewState;
    /** The ignored files that go along, as ticked now. */
    readonly ticked: readonly string[];
}

interface RunFacts {
    readonly host: HandoffHost;
    readonly lines: readonly string[];
    /** The session had a live process here when the hand-off started. */
    readonly wasRunning: boolean;
    /** Its process exited since. */
    readonly stopped: boolean;
}

export type SessionRunState =
    | {readonly phase: 'idle'}
    | (RunFacts & {readonly phase: 'waiting'})
    | (RunFacts & {readonly phase: 'running'})
    | (RunFacts & {readonly phase: 'done'; readonly copyPath: string})
    | (RunFacts & {readonly phase: 'failed'; readonly error: string});

export interface SessionHandoffState {
    readonly dialog: SessionHandoffDialogView | null;
    /** sessionId → its hand-off. */
    readonly runs: IdRecord<SessionRunState>;
}

export const initialSessionHandoffState: SessionHandoffState = {dialog: null, runs: {}};

const IDLE: SessionRunState = {phase: 'idle'};

/** How many progress lines are kept; a hand-off prints a few dozen. */
const MAX_LINES = 200;

export function sessionHandoffReducer(state: SessionHandoffState, event: RendererEvent): SessionHandoffState {
    switch (event.type) {
        case 'sessionHandoffDialogOpened': {
            const run = sessionRunIn(state, event.sessionId);
            return {
                dialog: {
                    sessionId: event.sessionId,
                    host: event.host,
                    name: event.name,
                    preview: {phase: 'loading'},
                    ticked: [],
                },
                // A run still going stays on screen; one that ended is forgotten.
                runs: inFlight(run) ? state.runs : withoutEntry(state.runs, event.sessionId),
            };
        }

        case 'sessionHandoffPreviewLoaded': {
            const dialog = state.dialog;
            if (!dialog || dialog.sessionId !== event.sessionId) return state;
            const answer = event.answer;
            if ('error' in answer)
                return {...state, dialog: {...dialog, preview: {phase: 'error', error: answer.error}}};
            const ticked = answer.candidates.filter((file) => file.ticked).map((file) => file.path);
            return {...state, dialog: {...dialog, preview: {phase: 'ok', preview: answer}, ticked}};
        }

        case 'sessionHandoffFileToggled': {
            const dialog = state.dialog;
            if (!dialog || dialog.preview.phase !== 'ok') return state;
            const ticked = dialog.ticked.includes(event.path)
                ? dialog.ticked.filter((path) => path !== event.path)
                : [...dialog.ticked, event.path];
            return {...state, dialog: {...dialog, ticked}};
        }

        case 'sessionHandoffDialogClosed':
            return state.dialog ? {...state, dialog: null} : state;

        case 'sessionHandoffStarted': {
            if (inFlight(sessionRunIn(state, event.sessionId))) return state;
            const facts: RunFacts = {host: event.host, lines: [], wasRunning: event.running, stopped: false};
            const next: SessionRunState = {...facts, phase: event.busy ? 'waiting' : 'running'};
            return {...state, runs: withEntry(state.runs, event.sessionId, next)};
        }

        case 'sessionHandoffPhase':
            return withPhase(state, event.sessionId, event.phase);

        // The answer repeats the last phase main pushed; it only matters when that push was lost.
        case 'sessionHandoffFinished':
            return inFlight(sessionRunIn(state, event.sessionId))
                ? withPhase(state, event.sessionId, event.phase)
                : state;

        case 'processExited': {
            const run = sessionRunIn(state, event.sessionId);
            if (!inFlight(run) || run.stopped) return state;
            return {...state, runs: withEntry(state.runs, event.sessionId, {...run, stopped: true})};
        }

        default:
            return state;
    }
}

function withPhase(state: SessionHandoffState, sessionId: string, phase: SessionHandoffPhase): SessionHandoffState {
    const run = sessionRunIn(state, sessionId);
    // A phase for a hand-off this window didn't start (it was reloaded since) has nothing to add to.
    if (run.phase === 'idle') return state;
    const {host, lines, wasRunning, stopped} = run;
    const facts: RunFacts = {host, lines, wasRunning, stopped};
    switch (phase.kind) {
        case 'waiting':
            return withRun(state, sessionId, {...facts, phase: 'waiting'});
        case 'running':
            return withRun(state, sessionId, {
                ...facts,
                phase: 'running',
                lines: phase.line ? [...lines, phase.line].slice(-MAX_LINES) : lines,
            });
        case 'done':
            return withRun(state, sessionId, {...facts, phase: 'done', copyPath: phase.copyPath});
        case 'failed':
            return withRun(state, sessionId, {
                ...facts,
                phase: 'failed',
                error: phase.error || 'The hand-off didn’t finish',
            });
        case 'cancelled':
            return {
                dialog: state.dialog?.sessionId === sessionId ? null : state.dialog,
                runs: withoutEntry(state.runs, sessionId),
            };
    }
}

function withRun(state: SessionHandoffState, sessionId: string, run: SessionRunState): SessionHandoffState {
    return {...state, runs: withEntry(state.runs, sessionId, run)};
}

/** A re-keyed session keeps its hand-off, and its dialog. */
export function rekeySessionHandoff(state: SessionHandoffState, oldId: string, newId: string): SessionHandoffState {
    const runs = movedEntry(state.runs, oldId, newId);
    const dialog = state.dialog?.sessionId === oldId ? {...state.dialog, sessionId: newId} : state.dialog;
    return runs === state.runs && dialog === state.dialog ? state : {dialog, runs};
}

// ── What the surfaces read ──

export function sessionRunIn(state: SessionHandoffState, sessionId: string): SessionRunState {
    return state.runs[sessionId] ?? IDLE;
}

/** Waiting for its turn to end, or running. */
export function inFlight(run: SessionRunState): run is SessionRunState & {phase: 'waiting' | 'running'} {
    return run.phase === 'waiting' || run.phase === 'running';
}
