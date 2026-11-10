/**
 * What the Mac's UI asks about bringing a VM session back to this Mac (#276),
 * the counterpart of a session's hand-off (`SessionHandoff`).
 *
 * A Bring back moves one conversation home: the branch the session works on
 * in the VM's copy is fetched straight from the copy into a worktree of the
 * local project, its transcript comes along, the VM session stops, and the
 * same row continues here with `claude --resume`. A session mid-turn is not
 * cut off: the Bring back waits for the turn to end, and can be cancelled
 * while it waits.
 *
 * When the branch is there already on the Mac (the worktree a hand-off left
 * behind, most often), nothing is written until the user says what to do with
 * it, as an issue's or a task's start asks: `reuse` brings the VM's commits
 * into the existing checkout (fast-forward only), `replace` deletes that
 * worktree and the branch and makes them afresh from the VM.
 *
 * Uncommitted changes on the VM come back uncommitted, and the VM checkout is
 * reset once they apply here, so the session can go out and back again.
 *
 * The IPC handlers call this; the composition root builds it.
 */
import type {ExistingBranch, ExistingBranchChoice} from '../../domain/project/branch-worktree';

/** What bringing a session back would do, as the dialog shows it. */
export interface SessionBringBackPreview {
    /** The VM copy the session runs in. */
    copyPath: string;
    /** The local project the copy was handed off from. */
    localPath: string;
    /** The branch the session works on, on the VM. */
    branch: string;
    /** The checkout on this Mac the session would continue in. */
    worktree: string;
    /** The branch exists on this Mac already: where, and what is on it. Null when it does not. */
    existing: ExistingBranch | null;
    /** How many files the VM checkout has uncommitted; they come back uncommitted, as a patch. */
    uncommitted: number;
    /** Whether Claude is mid-turn now, so the Bring back would wait. */
    busy: boolean;
}

/** Where a session's Bring back stands, as main pushes it to the renderer. */
export type SessionBringBackPhase =
    | {kind: 'waiting'}
    | {kind: 'running'; line: string}
    /** The branch exists here and no choice was made: nothing was changed. */
    | {kind: 'existing'; existing: ExistingBranch}
    /** `projectPath` is the checkout on this Mac the session resumed in. */
    | {kind: 'done'; projectPath: string}
    | {kind: 'failed'; error: string}
    | {kind: 'cancelled'};

export interface SessionBringBack {
    /** What a Bring back of `sessionId` would do; an error for a session that cannot be brought back. */
    preview(sessionId: string): Promise<SessionBringBackPreview | {error: string}>;
    /**
     * Bring the session back. With the branch already here, `existing` says
     * what to do with it; without one the answer is the `existing` phase.
     * Resolves when it is done, failed, cancelled or waiting on that choice;
     * every phase also goes to `onPhase`.
     */
    bringBack(
        sessionId: string,
        existing?: ExistingBranchChoice,
        onPhase?: (phase: SessionBringBackPhase) => void,
    ): Promise<SessionBringBackPhase>;
    /** Cancel a Bring back still waiting for its turn to end; false once it is running. */
    cancel(sessionId: string): boolean;
}
