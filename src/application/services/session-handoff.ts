/**
 * What the Mac's UI asks about handing a running session off to a VM (#276 stage 3).
 *
 * A session hand-off moves one conversation: the session's checkout is handed
 * off to the host as a project hand-off would (into a worktree of the same
 * name and branch on the VM when the session worked in one), its transcript
 * goes along, the local session stops, and the same row continues on the VM
 * with `claude --resume`. A session mid-turn is not cut off: the hand-off
 * waits for the turn to end, and can be cancelled while it waits.
 *
 * The IPC handlers call this; the composition root builds it.
 */
import type {HandoffCandidate} from './project-handoff';

/** What handing a session off would carry, as the dialog shows it. */
export interface SessionHandoffPreview {
    /** The local project the session belongs to. */
    localPath: string;
    /** The worktree the session works in, by name; null for the project's own checkout. */
    worktree: string | null;
    branch: string;
    unpushed: number;
    uncommitted: number;
    candidates: HandoffCandidate[];
    /** Whether Claude is mid-turn now, so the hand-off would wait. */
    busy: boolean;
}

/** Where a session's hand-off stands, as main pushes it to the renderer. */
export type SessionHandoffPhase =
    | {kind: 'waiting'}
    | {kind: 'running'; line: string}
    | {kind: 'done'; copyPath: string}
    | {kind: 'failed'; error: string}
    | {kind: 'cancelled'};

export interface SessionHandoff {
    /** What a hand-off of `sessionId` would carry; an error for a session that cannot be handed off. */
    preview(sessionId: string): Promise<SessionHandoffPreview | {error: string}>;
    /**
     * Hand the session off to `hostKey`, carrying the `ticked` files. Resolves
     * when it is done, failed or cancelled; every phase also goes to `onPhase`.
     */
    handOff(
        sessionId: string,
        hostKey: string,
        ticked: string[],
        onPhase?: (phase: SessionHandoffPhase) => void,
    ): Promise<SessionHandoffPhase>;
    /** Cancel a hand-off still waiting for its turn to end; false once it is running. */
    cancel(sessionId: string): boolean;
}
