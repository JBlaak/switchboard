/**
 * What the Bring back dialog says (#276), without React: what comes back, the
 * question about a branch that is here already, and where the run stands.
 */
import type {ExistingBranch} from '../../../domain/project/branch-worktree';
import type {SessionBringBackPhase, SessionBringBackPreview} from '../../../application/services/session-bring-back';
import type {BringBackRunState} from '../../state/session-bring-back-slice';
import type {CarriedLine} from '../project-page/handoff-view';

/** What comes back to this Mac, a line each. */
export function bringBackLines(preview: SessionBringBackPreview): CarriedLine[] {
    return [
        {text: 'The conversation, resumed on this Mac in the same row'},
        {text: 'The branch ', code: preview.branch},
        {
            text: preview.existing?.worktreePath ? 'Into the worktree at ' : 'Into a new worktree at ',
            code: preview.worktree,
        },
    ];
}

/** The branch is here already: where, and what is on it. */
export function existingLine({branch, worktreePath, main, changedFiles, ahead}: ExistingBranch): string {
    const where = main
        ? 'checked out in the main checkout'
        : worktreePath
          ? 'in a worktree on this Mac'
          : 'on this Mac, without a worktree';
    const work = [
        changedFiles ? plural(changedFiles, 'uncommitted file') : '',
        ahead ? plural(ahead, 'commit') + ' not on the default branch' : '',
    ].filter(Boolean);
    return `${branch} is ${where} already` + (work.length ? `, with ${work.join(' and ')}.` : '.');
}

/** What Update it does, under its button. */
export const UPDATE_NOTE =
    'Update it brings the VM’s commits into it. Git refuses when it has commits the VM lacks, or changes those commits would overwrite.';

/** What deleting takes with it, asked before it does. */
export function deleteLine({worktreePath, changedFiles, ahead}: ExistingBranch): string {
    const lost = [
        changedFiles ? plural(changedFiles, 'uncommitted file') : '',
        ahead ? plural(ahead, 'commit') + ' not on the default branch' : '',
    ].filter(Boolean);
    const what = worktreePath ? `the worktree at ${worktreePath} and its branch` : 'the branch';
    return (
        `Delete ${what}` +
        (lost.length ? `, with ${lost.join(' and ')},` : '') +
        ' and recreate it from the VM? Anything here that is not on the VM or pushed is gone for good.'
    );
}

/** A note when Claude is mid-turn, so the Bring back waits; null otherwise. */
export function bringBackBusyNote(preview: SessionBringBackPreview, run: BringBackRunState): string | null {
    if (!preview.busy || run.phase !== 'idle') return null;
    return 'Claude is in the middle of a turn. The Bring back waits for it to end.';
}

/** The run, as the dialog's status line, log, error and buttons show it. */
export interface BringBackRunView {
    status: string | null;
    lines: readonly string[];
    error: string | null;
    done: string | null;
    /** The question about a branch that is here already, from the run (the preview's is the dialog's own). */
    existing: ExistingBranch | null;
    /** Bring back or Retry; null while it runs, once done, or while a choice is asked. */
    primary: {label: string; disabled: boolean} | null;
    secondary: {label: string; does: 'cancel' | 'close'};
}

export function bringBackRunView(run: BringBackRunState): BringBackRunView {
    const none = {status: null, lines: [], error: null, done: null, existing: null};
    switch (run.phase) {
        case 'idle':
            return {
                ...none,
                primary: {label: 'Bring back', disabled: false},
                secondary: {label: 'Cancel', does: 'close'},
            };
        case 'waiting':
            return {
                ...none,
                status: 'Waiting for the turn to end…',
                lines: run.lines,
                primary: null,
                secondary: {label: 'Cancel', does: 'cancel'},
            };
        case 'running':
            return {
                ...none,
                status: 'Bringing it back…',
                lines: run.lines,
                primary: null,
                secondary: {label: 'Close', does: 'close'},
            };
        case 'existing':
            return {
                ...none,
                lines: run.lines,
                existing: run.existing,
                primary: null,
                secondary: {label: 'Cancel', does: 'close'},
            };
        case 'done':
            return {
                ...none,
                lines: run.lines,
                done: 'Continues on this Mac in ' + run.projectPath,
                primary: null,
                secondary: {label: 'Close', does: 'close'},
            };
        case 'failed':
            return {
                ...none,
                lines: run.lines,
                error: run.error,
                primary: {label: 'Retry', disabled: false},
                secondary: {label: 'Close', does: 'close'},
            };
    }
}

// ── Shapes ──

export function bringBackPreviewAnswer(value: unknown): SessionBringBackPreview | {error: string} {
    if (!value || typeof value !== 'object') return {error: 'Couldn’t read the session'};
    const preview = value as Record<string, unknown>;
    if (typeof preview.error === 'string') return {error: preview.error};
    if (
        typeof preview.copyPath === 'string' &&
        typeof preview.localPath === 'string' &&
        typeof preview.branch === 'string' &&
        typeof preview.worktree === 'string' &&
        (preview.existing === null || isExisting(preview.existing)) &&
        typeof preview.busy === 'boolean'
    ) {
        return value as SessionBringBackPreview;
    }
    return {error: 'Couldn’t read the session'};
}

export function bringBackPhaseAnswer(value: unknown): SessionBringBackPhase {
    const phase = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    switch (phase.kind) {
        case 'waiting':
        case 'cancelled':
            return {kind: phase.kind};
        case 'running':
            return {kind: 'running', line: typeof phase.line === 'string' ? phase.line : ''};
        case 'existing':
            if (isExisting(phase.existing)) return {kind: 'existing', existing: phase.existing};
            break;
        case 'done':
            if (typeof phase.projectPath === 'string') return {kind: 'done', projectPath: phase.projectPath};
            break;
        case 'failed':
            return {kind: 'failed', error: typeof phase.error === 'string' ? phase.error : ''};
    }
    return {kind: 'failed', error: typeof phase.error === 'string' ? phase.error : 'The Bring back didn’t finish'};
}

function isExisting(value: unknown): value is ExistingBranch {
    if (!value || typeof value !== 'object') return false;
    const existing = value as Record<string, unknown>;
    return (
        typeof existing.branch === 'string' &&
        (existing.worktreePath === null || typeof existing.worktreePath === 'string') &&
        typeof existing.main === 'boolean' &&
        typeof existing.changedFiles === 'number' &&
        typeof existing.ahead === 'number'
    );
}

function plural(count: number, noun: string): string {
    return count + ' ' + noun + (count === 1 ? '' : 's');
}
