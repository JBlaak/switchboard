/**
 * What the Mac's UI asks about handing projects off to VMs (#276 stage 2).
 *
 * A hand-off makes (or updates) a copy of a local project on a VM host: the
 * agent clones origin with its own credentials, the Mac's unpushed commits go
 * over as a git bundle, its uncommitted changes as a patch, and the ignored
 * config files the user ticked are written in. The copy is a project of its
 * own (an ssh:// path on the VM, with the VM badge), linked to the local one.
 * Work comes back only through git: Bring back pushes the copy's branch from
 * the VM and checks it out in a local worktree.
 *
 * The IPC handlers call this; the composition root builds it.
 */

/** A VM host a project can be handed off to. */
export interface HandoffHost {
    /** `user@host:port`, which names the host from here on. */
    key: string;
    /** What the picker shows, e.g. `dev@buildbox`. */
    label: string;
}

/** An ignored file that looks like config (`.env*` and the like), offered to be carried along. */
export interface HandoffCandidate {
    /** Relative to the repository root. */
    path: string;
    size: number;
    /** Ticked by default: the user's choice from the last hand-off, or on for a first one. */
    ticked: boolean;
}

/** What a hand-off of a local project would carry, as the dialog shows it. */
export interface HandoffPreview {
    branch: string;
    /** Commits origin does not have, which go over as a bundle. */
    unpushed: number;
    /** Paths with uncommitted changes, which go over as a patch. */
    uncommitted: number;
    candidates: HandoffCandidate[];
    /** The copies this project already has, by host key, so the dialog can say "updates the copy on …". */
    existing: Record<string, string>;
}

/** What the user chose in the hand-off dialog beyond the files (stage 5). */
export interface HandoffChoices {
    /** Run the project's schedules in the copy on the VM from now on (Q18; the dialog defaults to yes). */
    schedulesOnVm?: boolean;
}

/** A local project's copy on a VM. */
export interface ProjectCopy {
    /** The copy's own project path, `ssh://user@host[:port]/dir`. */
    copyPath: string;
    hostKey: string;
    hostLabel: string;
}

/** Where a copy stands on its VM, for Bring back and for removing it. */
export interface CopyStatus {
    branch: string | null;
    unpushed: {oid: string; subject: string}[];
    uncommitted: string[];
}

export type HandoffResult = {ok: true; copyPath: string; reused: boolean} | {ok: false; error: string};
export type BringBackResult = {ok: true; worktree: string; branch: string} | {ok: false; error: string};

export interface ProjectHandoff {
    /** The VM hosts there are (remotes with an agent), one per host. */
    hosts(): HandoffHost[];
    /** What handing `localPath` off would carry; an error for a folder that is not a git repository with an origin. */
    preview(localPath: string): Promise<HandoffPreview | {error: string}>;
    /**
     * Hand `localPath` off to the host `hostKey`, carrying the `ticked` ignored
     * files (remembered for next time). Progress lines go to `onProgress`. On
     * success the copy is a VM project linked to `localPath`.
     */
    handOff(
        localPath: string,
        hostKey: string,
        ticked: string[],
        onProgress?: (line: string) => void,
        options?: HandoffChoices,
    ): Promise<HandoffResult>;
    /** The local project's copies. */
    copiesOf(localPath: string): ProjectCopy[];
    /** The local project a copy was made from, or null for a remote that is not a copy. */
    originOf(copyPath: string): string | null;
    /** Where the copy stands; null when its VM cannot be reached. */
    copyStatus(copyPath: string): Promise<CopyStatus | null>;
    /**
     * Push the copy's branch from the VM (when it has unpushed commits), fetch it
     * here, and check it out in a new worktree of the local project.
     */
    bringBack(copyPath: string, onProgress?: (line: string) => void): Promise<BringBackResult>;
    /** Delete the copy's folder on the VM and forget the project. The UI has confirmed against `copyStatus` first. */
    removeCopy(copyPath: string): Promise<{ok: true} | {ok: false; error: string}>;
}
