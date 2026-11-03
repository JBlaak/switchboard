/**
 * Project hand-off as the renderer shows it (#276 stage 2): the VM hosts a
 * local project can be handed off to, each local project's copies and each
 * copy's local project, the Hand off dialog with its preview, ticks and run,
 * and, per copy, a Bring back and a removal.
 *
 * A hand-off's run is kept per local project rather than in the dialog, so
 * closing the dialog while it runs and opening it again shows the same run,
 * not a second Hand off button. Bring back and removal are kept per copy.
 *
 * Stage 5 adds where a project's schedules run (Q18), kept per project page
 * (the local project's, or a copy's), and the dialog's "Run this project's
 * schedules on the VM", on by default.
 *
 * The events are declared here rather than in `events.ts`, like the agent
 * host ones; `events.ts` folds them into the union. The progress lines are
 * main's pushes and live there.
 */
import {withEntry, withoutEntry} from './records';
import type {
    BringBackResult,
    CopyStatus,
    HandoffHost,
    HandoffPreview,
    HandoffResult,
    ProjectCopy,
} from '../../application/services/project-handoff';
import type {ScheduleLocation} from '../../application/services/vm-schedules';
import type {IdRecord} from './records';
import type {RendererEvent} from './events';

export type HandoffEvent =
    | {type: 'handoffHostsLoaded'; hosts: readonly HandoffHost[]}
    | {type: 'handoffCopiesLoaded'; localPath: string; copies: readonly ProjectCopy[]}
    /** Null: the remote project isn't a copy. */
    | {type: 'handoffOriginLoaded'; copyPath: string; origin: string | null}
    /** Hand off to… was pressed, with this host picked. */
    | {type: 'handoffDialogOpened'; localPath: string; host: HandoffHost}
    | {type: 'handoffPreviewLoaded'; localPath: string; answer: HandoffPreview | {error: string}}
    /** One of the ignored files was ticked or unticked. */
    | {type: 'handoffFileToggled'; path: string}
    | {type: 'handoffDialogClosed'}
    /** Hand off or Retry was pressed. */
    | {type: 'handoffStarted'; localPath: string; hostKey: string}
    | {type: 'handoffFinished'; localPath: string; result: HandoffResult}
    | {type: 'bringBackStarted'; copyPath: string}
    | {type: 'bringBackFinished'; copyPath: string; result: BringBackResult}
    /** Remove copy was pressed: the copy's status is being asked. */
    | {type: 'copyRemoveChecking'; copyPath: string}
    /** The status came back; null when the VM couldn't be reached. */
    | {type: 'copyRemoveChecked'; copyPath: string; status: CopyStatus | null}
    /** The removal was called off: the confirm, or the list of work left, was answered no. */
    | {type: 'copyRemoveCancelled'; copyPath: string}
    | {type: 'copyRemoving'; copyPath: string}
    | {type: 'copyRemoveFinished'; copyPath: string; result: {ok: true} | {ok: false; error: string}}
    /** Where the schedules of this page's project run; null with neither schedules nor copies. */
    | {type: 'schedulesLoaded'; projectPath: string; location: ScheduleLocation | null}
    /** The Schedules line's switch was moved: main is told. */
    | {type: 'schedulesMoving'; projectPath: string}
    | {type: 'schedulesMoved'; projectPath: string; answer: ScheduleLocation | {error: string}}
    /** The dialog's "Run this project's schedules on the VM" was ticked or unticked. */
    | {type: 'handoffSchedulesToggled'};

export type PreviewState =
    | {readonly phase: 'loading'}
    | {readonly phase: 'ok'; readonly preview: HandoffPreview}
    | {readonly phase: 'error'; readonly error: string};

export interface HandoffDialogView {
    readonly localPath: string;
    readonly host: HandoffHost;
    readonly preview: PreviewState;
    /** The ignored files that go along, as ticked now. */
    readonly ticked: readonly string[];
    /** Run the project's schedules in the copy on the VM from now on; on by default (Q18). */
    readonly schedulesOnVm: boolean;
}

/** Where a page's project runs its schedules, and the switch's own state. */
export interface SchedulesState {
    /** Null: main hasn't said, or the project has neither schedules nor copies. */
    readonly location: ScheduleLocation | null;
    readonly moving: boolean;
    /** Why the last move failed, e.g. "Couldn't reach the VM". */
    readonly error: string | null;
}

export type RunState =
    | {readonly phase: 'idle'}
    | {readonly phase: 'running'; readonly hostKey: string; readonly lines: readonly string[]}
    | {
          readonly phase: 'failed';
          readonly hostKey: string;
          readonly lines: readonly string[];
          readonly error: string;
      }
    | {
          readonly phase: 'done';
          readonly hostKey: string;
          readonly lines: readonly string[];
          readonly copyPath: string;
          readonly reused: boolean;
      };

export type BringBackState =
    | {readonly phase: 'idle'}
    | {readonly phase: 'running'; readonly lines: readonly string[]}
    | {readonly phase: 'failed'; readonly lines: readonly string[]; readonly error: string}
    | {readonly phase: 'done'; readonly lines: readonly string[]; readonly worktree: string; readonly branch: string};

export type RemoveState =
    | {readonly phase: 'idle'}
    | {readonly phase: 'checking'}
    /** The VM couldn't be reached, so nothing was removed. */
    | {readonly phase: 'unreachable'}
    /** The copy is clean; the native confirm is up. */
    | {readonly phase: 'confirming'}
    /** The copy has work that isn't anywhere else: listed, with Bring back first and Remove anyway. */
    | {readonly phase: 'dirty'; readonly status: CopyStatus}
    | {readonly phase: 'removing'}
    | {readonly phase: 'failed'; readonly error: string}
    | {readonly phase: 'removed'};

export interface HandoffState {
    /** Null until main has answered. */
    readonly hosts: readonly HandoffHost[] | null;
    /** localPath → its copies, for the local project pages that asked. */
    readonly copies: IdRecord<readonly ProjectCopy[]>;
    /** copyPath → the local project it was made from, or null for a remote that isn't a copy. */
    readonly origins: IdRecord<string | null>;
    readonly dialog: HandoffDialogView | null;
    /** localPath → its hand-off. */
    readonly runs: IdRecord<RunState>;
    /** copyPath → its Bring back. */
    readonly bringBacks: IdRecord<BringBackState>;
    /** copyPath → its removal. */
    readonly removals: IdRecord<RemoveState>;
    /** projectPath (local or copy) → where its schedules run. */
    readonly schedules: IdRecord<SchedulesState>;
}

export const initialHandoffState: HandoffState = {
    hosts: null,
    copies: {},
    origins: {},
    dialog: null,
    runs: {},
    bringBacks: {},
    removals: {},
    schedules: {},
};

const IDLE_RUN: RunState = {phase: 'idle'};
const IDLE_BRING_BACK: BringBackState = {phase: 'idle'};
const IDLE_REMOVE: RemoveState = {phase: 'idle'};
const NO_SCHEDULES: SchedulesState = {location: null, moving: false, error: null};

/** How many progress lines are kept; a hand-off prints a few dozen. */
const MAX_LINES = 200;

export function handoffReducer(state: HandoffState, event: RendererEvent): HandoffState {
    switch (event.type) {
        case 'handoffHostsLoaded':
            return {...state, hosts: event.hosts};

        case 'handoffCopiesLoaded':
            return {...state, copies: withEntry(state.copies, event.localPath, event.copies)};

        case 'handoffOriginLoaded':
            return {...state, origins: withEntry(state.origins, event.copyPath, event.origin)};

        case 'handoffDialogOpened': {
            const run = state.runs[event.localPath] ?? IDLE_RUN;
            return {
                ...state,
                dialog: {
                    localPath: event.localPath,
                    host: event.host,
                    preview: {phase: 'loading'},
                    ticked: [],
                    schedulesOnVm: true,
                },
                // A run still going stays on screen; one that ended is forgotten.
                runs: run.phase === 'running' ? state.runs : withoutEntry(state.runs, event.localPath),
            };
        }

        case 'handoffPreviewLoaded': {
            const dialog = state.dialog;
            if (!dialog || dialog.localPath !== event.localPath) return state;
            const answer = event.answer;
            if ('error' in answer)
                return {...state, dialog: {...dialog, preview: {phase: 'error', error: answer.error}}};
            const ticked = answer.candidates.filter((file) => file.ticked).map((file) => file.path);
            return {...state, dialog: {...dialog, preview: {phase: 'ok', preview: answer}, ticked}};
        }

        case 'handoffFileToggled': {
            const dialog = state.dialog;
            if (!dialog || dialog.preview.phase !== 'ok') return state;
            const ticked = dialog.ticked.includes(event.path)
                ? dialog.ticked.filter((path) => path !== event.path)
                : [...dialog.ticked, event.path];
            return {...state, dialog: {...dialog, ticked}};
        }

        case 'handoffSchedulesToggled': {
            const dialog = state.dialog;
            if (!dialog) return state;
            return {...state, dialog: {...dialog, schedulesOnVm: !dialog.schedulesOnVm}};
        }

        case 'handoffDialogClosed':
            return state.dialog ? {...state, dialog: null} : state;

        case 'handoffStarted': {
            const run = state.runs[event.localPath] ?? IDLE_RUN;
            if (run.phase === 'running') return state;
            return {
                ...state,
                runs: withEntry(state.runs, event.localPath, {phase: 'running', hostKey: event.hostKey, lines: []}),
            };
        }

        case 'handoffProgress': {
            const run = state.runs[event.localPath];
            if (run?.phase !== 'running') return state;
            const lines = [...run.lines, event.line].slice(-MAX_LINES);
            return {...state, runs: withEntry(state.runs, event.localPath, {...run, lines})};
        }

        case 'handoffFinished': {
            const run = state.runs[event.localPath] ?? IDLE_RUN;
            const hostKey = run.phase === 'idle' ? '' : run.hostKey;
            const lines = run.phase === 'idle' ? [] : run.lines;
            const result = event.result;
            const next: RunState = result.ok
                ? {phase: 'done', hostKey, lines, copyPath: result.copyPath, reused: result.reused}
                : {phase: 'failed', hostKey, lines, error: result.error || 'The hand-off didn’t finish'};
            return {...state, runs: withEntry(state.runs, event.localPath, next)};
        }

        case 'bringBackStarted': {
            const current = state.bringBacks[event.copyPath] ?? IDLE_BRING_BACK;
            if (current.phase === 'running') return state;
            return {...state, bringBacks: withEntry(state.bringBacks, event.copyPath, {phase: 'running', lines: []})};
        }

        case 'bringBackProgress': {
            const current = state.bringBacks[event.copyPath];
            if (current?.phase !== 'running') return state;
            const lines = [...current.lines, event.line].slice(-MAX_LINES);
            return {...state, bringBacks: withEntry(state.bringBacks, event.copyPath, {phase: 'running', lines})};
        }

        case 'bringBackFinished': {
            const current = state.bringBacks[event.copyPath] ?? IDLE_BRING_BACK;
            const lines = current.phase === 'idle' ? [] : current.lines;
            const result = event.result;
            const next: BringBackState = result.ok
                ? {phase: 'done', lines, worktree: result.worktree, branch: result.branch}
                : {phase: 'failed', lines, error: result.error || 'The work couldn’t be brought back'};
            return {
                ...state,
                bringBacks: withEntry(state.bringBacks, event.copyPath, next),
                // What the removal listed may be on origin now; it is asked again on the next Remove.
                removals: result.ok ? withoutEntry(state.removals, event.copyPath) : state.removals,
            };
        }

        case 'copyRemoveChecking':
            return withRemoval(state, event.copyPath, {phase: 'checking'});

        case 'copyRemoveChecked': {
            const decision = removeDecision(event.status);
            const next: RemoveState =
                decision === 'unreachable'
                    ? {phase: 'unreachable'}
                    : decision === 'clean' || !event.status
                      ? {phase: 'confirming'}
                      : {phase: 'dirty', status: event.status};
            return withRemoval(state, event.copyPath, next);
        }

        case 'copyRemoveCancelled':
            return withRemoval(state, event.copyPath, IDLE_REMOVE);

        case 'copyRemoving':
            return withRemoval(state, event.copyPath, {phase: 'removing'});

        case 'copyRemoveFinished': {
            const result = event.result;
            if (!result.ok) return withRemoval(state, event.copyPath, {phase: 'failed', error: result.error});
            const copies: Record<string, readonly ProjectCopy[]> = {};
            for (const [localPath, list] of Object.entries(state.copies)) {
                copies[localPath] = list.some((copy) => copy.copyPath === event.copyPath)
                    ? list.filter((copy) => copy.copyPath !== event.copyPath)
                    : list;
            }
            return {
                ...withRemoval(state, event.copyPath, {phase: 'removed'}),
                copies,
                origins: withoutEntry(state.origins, event.copyPath),
                bringBacks: withoutEntry(state.bringBacks, event.copyPath),
            };
        }

        case 'schedulesLoaded': {
            const current = state.schedules[event.projectPath] ?? NO_SCHEDULES;
            return withSchedules(state, event.projectPath, {...current, location: event.location});
        }

        case 'schedulesMoving': {
            const current = state.schedules[event.projectPath] ?? NO_SCHEDULES;
            return withSchedules(state, event.projectPath, {...current, moving: true, error: null});
        }

        case 'schedulesMoved': {
            const current = state.schedules[event.projectPath] ?? NO_SCHEDULES;
            const answer = event.answer;
            if ('error' in answer) {
                return withSchedules(state, event.projectPath, {
                    ...current,
                    moving: false,
                    error: answer.error || 'The schedules couldn’t be moved',
                });
            }
            // The other page of the same project (the local one, or a copy's) follows.
            const schedules: Record<string, SchedulesState> = {};
            for (const [path, entry] of Object.entries(state.schedules)) {
                schedules[path] = entry.location?.localPath === answer.localPath ? {...entry, location: answer} : entry;
            }
            schedules[event.projectPath] = {location: answer, moving: false, error: null};
            return {...state, schedules};
        }

        default:
            return state;
    }
}

function withSchedules(state: HandoffState, projectPath: string, next: SchedulesState): HandoffState {
    return {...state, schedules: withEntry(state.schedules, projectPath, next)};
}

function withRemoval(state: HandoffState, copyPath: string, next: RemoveState): HandoffState {
    return {...state, removals: withEntry(state.removals, copyPath, next)};
}

// ── The rules the surfaces and actions share ──

/**
 * What Remove copy does with the copy's status: say the VM can't be reached
 * (and remove nothing), confirm a clean copy, or list the work only the copy
 * has.
 */
export function removeDecision(status: CopyStatus | null): 'unreachable' | 'clean' | 'dirty' {
    if (!status) return 'unreachable';
    return status.unpushed.length > 0 || status.uncommitted.length > 0 ? 'dirty' : 'clean';
}

// ── What the surfaces read ──

export function copiesIn(state: HandoffState, localPath: string): readonly ProjectCopy[] {
    return state.copies[localPath] ?? [];
}

/** The local project a copy was made from; null when it isn't one, or main hasn't said. */
export function originIn(state: HandoffState, copyPath: string): string | null {
    return state.origins[copyPath] ?? null;
}

export function runIn(state: HandoffState, localPath: string): RunState {
    return state.runs[localPath] ?? IDLE_RUN;
}

export function bringBackIn(state: HandoffState, copyPath: string): BringBackState {
    return state.bringBacks[copyPath] ?? IDLE_BRING_BACK;
}

export function removalIn(state: HandoffState, copyPath: string): RemoveState {
    return state.removals[copyPath] ?? IDLE_REMOVE;
}

export function schedulesIn(state: HandoffState, projectPath: string): SchedulesState {
    return state.schedules[projectPath] ?? NO_SCHEDULES;
}
