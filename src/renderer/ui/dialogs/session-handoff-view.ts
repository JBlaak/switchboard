/**
 * What session hand-off says (#276 stage 3), from the session hand-off
 * slice: the dialog's lines in session mode, its notes and buttons while the
 * hand-off waits, runs and finishes, and the row's marker.
 *
 * Pure, so it is tested in node.
 */
import {carriedLines} from '../project-page/handoff-view';
import type {CarriedLine} from '../project-page/handoff-view';
import type {SessionHandoffPhase, SessionHandoffPreview} from '../../../application/services/session-handoff';
import type {SessionRunState} from '../../state/session-handoff-slice';

/** What goes over: the conversation, the branch, the worktree it works in, then what only this Mac has. */
export function sessionCarriedLines(preview: SessionHandoffPreview): CarriedLine[] {
    const [branch, ...rest] = carriedLines(preview);
    const lines: CarriedLine[] = [{text: 'The conversation, resumed on the VM'}, branch];
    if (preview.worktree) lines.push({text: 'In worktree ', code: preview.worktree});
    return [...lines, ...rest];
}

/** The note when Claude is mid-turn as the dialog opens. */
export const BUSY_NOTE = 'Claude is mid-turn. The hand-off starts when this turn ends.';

/** The busy note, said until the hand-off is under way, which then says it itself. */
export function busyNote(preview: SessionHandoffPreview, run: SessionRunState): string | null {
    return preview.busy && run.phase === 'idle' ? BUSY_NOTE : null;
}

export const WAITING_LINE = 'Waiting for the turn to end…';

/** A button the dialog shows, and what pressing it does. */
export interface SessionButton {
    readonly label: string;
    readonly disabled: boolean;
    /** Hand off (or Retry), Cancel the waiting hand-off, or close the dialog. */
    readonly does: 'handOff' | 'cancel' | 'close';
}

/** The dialog's state while a session is handed off, as its lines and buttons show it. */
export interface SessionRunView {
    /** "Waiting for the turn to end…" while it waits. */
    readonly status: string | null;
    readonly lines: readonly string[];
    readonly error: string | null;
    /** Under the error: where that leaves the session here. */
    readonly errorNote: string | null;
    /** "Continues on dev@buildbox", once it is done. */
    readonly done: string | null;
    /** Null when there is nothing left to press but Close. */
    readonly primary: SessionButton | null;
    readonly secondary: SessionButton;
    /** The ignored files can still be ticked. */
    readonly editable: boolean;
}

export function sessionRunView(run: SessionRunState): SessionRunView {
    const quiet = {status: null, lines: [], error: null, errorNote: null, done: null};
    switch (run.phase) {
        case 'idle':
            return {
                ...quiet,
                primary: {label: 'Hand off', disabled: false, does: 'handOff'},
                secondary: {label: 'Cancel', disabled: false, does: 'close'},
                editable: true,
            };
        case 'waiting':
            return {
                ...quiet,
                status: WAITING_LINE,
                lines: run.lines,
                primary: {label: 'Waiting…', disabled: true, does: 'handOff'},
                secondary: {label: 'Cancel', disabled: false, does: 'cancel'},
                editable: false,
            };
        case 'running':
            return {
                ...quiet,
                lines: run.lines,
                primary: {label: 'Handing off…', disabled: true, does: 'handOff'},
                secondary: {label: 'Close', disabled: false, does: 'close'},
                editable: false,
            };
        case 'done':
            return {
                ...quiet,
                lines: run.lines,
                done: 'Continues on ' + run.host.label,
                primary: null,
                secondary: {label: 'Close', disabled: false, does: 'close'},
                editable: false,
            };
        case 'failed':
            return {
                ...quiet,
                lines: run.lines,
                error: run.error,
                errorNote: failedNote(run),
                primary: {label: 'Retry', disabled: false, does: 'handOff'},
                secondary: {label: 'Close', disabled: false, does: 'close'},
                editable: true,
            };
    }
}

/**
 * Where a failed hand-off leaves the session. It wasn't moved; whether it is
 * still running here depends on whether its process exited before the
 * failure, which is all the renderer can tell.
 */
export function failedNote(run: SessionRunState & {phase: 'failed'}): string {
    if (!run.wasRunning) return 'The session wasn’t moved.';
    if (run.stopped) return 'The session wasn’t moved. It stopped here; open it to resume.';
    return 'The session wasn’t moved and is still running here.';
}

/** The row's marker while a hand-off is in flight, even with the dialog closed. */
export function rowHandoffMarker(run: SessionRunState): string | null {
    if (run.phase === 'waiting') return 'Waiting…';
    if (run.phase === 'running') return 'Handing off…';
    return null;
}

/** The marker's tooltip. */
export function rowHandoffTitle(run: SessionRunState): string | null {
    if (run.phase === 'waiting') return 'Hands off to ' + run.host.label + ' when this turn ends';
    if (run.phase === 'running') return 'Handing off to ' + run.host.label;
    return null;
}

/** The answer as a phase; anything else, such as main's `{ ok: false, error }`, is a failure. */
export function phaseAnswer(value: unknown): SessionHandoffPhase {
    const answer = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    if (answer.kind === 'done' && typeof answer.copyPath === 'string') return {kind: 'done', copyPath: answer.copyPath};
    if (answer.kind === 'cancelled') return {kind: 'cancelled'};
    if (answer.kind === 'waiting') return {kind: 'waiting'};
    if (answer.kind === 'running' && typeof answer.line === 'string') return {kind: 'running', line: answer.line};
    return {kind: 'failed', error: typeof answer.error === 'string' ? answer.error : ''};
}
