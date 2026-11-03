/**
 * What project hand-off says on the project page (#276 stage 2), from the
 * hand-off slice: whether Hand off to… shows, the dialog's lines, ticks and
 * run, a copy's Bring back, what Remove copy lists, and the links between a
 * local project and its copies.
 *
 * Pure, so it is tested in node.
 */
import {isRemoteProjectPath} from '../../../domain/project/remote-target';
import {projectLabel} from '../../features/sessions/project-label';
import type {CopyStatus, HandoffHost, HandoffPreview, ProjectCopy} from '../../../application/services/project-handoff';
import type {BringBackState, RunState} from '../../state/handoff-slice';

/** Whether Hand off to… shows: on a local project, once there is a VM to hand it to. */
export function showsHandOff(projectPath: string, hosts: readonly HandoffHost[] | null): boolean {
    return !isRemoteProjectPath(projectPath) && !!hosts && hosts.length > 0;
}

/** One host opens the dialog at once; several open a picker first. */
export function handOffOpens(
    hosts: readonly HandoffHost[],
): {kind: 'dialog'; host: HandoffHost} | {kind: 'picker'; hosts: readonly HandoffHost[]} {
    return hosts.length === 1 ? {kind: 'dialog', host: hosts[0]} : {kind: 'picker', hosts};
}

/** A line of what goes over: its words, and the part shown as code (a branch name). */
export interface CarriedLine {
    readonly text: string;
    readonly code?: string;
}

/** What goes over: the branch, then the commits and the changes that only this Mac has. */
export function carriedLines(preview: HandoffPreview): CarriedLine[] {
    const lines: CarriedLine[] = [{text: 'Branch ', code: preview.branch}];
    if (preview.unpushed > 0) lines.push({text: count(preview.unpushed, 'commit') + ' not on origin'});
    if (preview.uncommitted > 0) lines.push({text: count(preview.uncommitted, 'uncommitted change')});
    if (preview.unpushed === 0 && preview.uncommitted === 0) lines.push({text: 'Nothing unpushed or uncommitted'});
    return lines;
}

/** The line under the ignored files. */
export const FILES_NOTE = 'Ticked files are copied to the VM as they are.';

/** "Updates the copy on dev@buildbox", when the project already has a copy on the host. */
export function existingNote(preview: HandoffPreview, host: HandoffHost): string | null {
    return preview.existing[host.key] ? 'Updates the copy on ' + host.label : null;
}

/** A file's size, short: "312 B", "4.1 KB", "2.3 MB". */
export function fileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb).toString()) + ' KB';
    const mb = kb / 1024;
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb).toString()) + ' MB';
}

/** The dialog's state, as its buttons and lines show it. */
export interface RunView {
    /** The primary button: Hand off, Handing off…, Retry, or Open the copy. */
    readonly label: string;
    readonly disabled: boolean;
    readonly lines: readonly string[];
    readonly error: string | null;
    /** "Handed off", once it is done. */
    readonly done: string | null;
    /** The copy Open the copy goes to. */
    readonly copyPath: string | null;
}

export function runView(run: RunState): RunView {
    switch (run.phase) {
        case 'idle':
            return {label: 'Hand off', disabled: false, lines: [], error: null, done: null, copyPath: null};
        case 'running':
            return {label: 'Handing off…', disabled: true, lines: run.lines, error: null, done: null, copyPath: null};
        case 'failed':
            return {label: 'Retry', disabled: false, lines: run.lines, error: run.error, done: null, copyPath: null};
        case 'done':
            return {
                label: 'Open the copy',
                disabled: false,
                lines: run.lines,
                error: null,
                done: run.reused ? 'Handed off. The copy is up to date.' : 'Handed off',
                copyPath: run.copyPath,
            };
    }
}

/** A copy's Bring back, as its button and lines show it. */
export interface BringBackView {
    readonly label: string;
    readonly disabled: boolean;
    readonly lines: readonly string[];
    readonly error: string | null;
    /** What it checked out, once it is done. */
    readonly branch: string | null;
}

export function bringBackView(state: BringBackState): BringBackView {
    switch (state.phase) {
        case 'idle':
            return {label: 'Bring back', disabled: false, lines: [], error: null, branch: null};
        case 'running':
            return {label: 'Bringing back…', disabled: true, lines: state.lines, error: null, branch: null};
        case 'failed':
            return {label: 'Retry', disabled: false, lines: state.lines, error: state.error, branch: null};
        case 'done':
            return {label: 'Bring back', disabled: false, lines: state.lines, error: null, branch: state.branch};
    }
}

/** Up to `cap` of a list, and "and N more" for the rest. */
export interface Capped {
    readonly shown: readonly string[];
    readonly more: string | null;
}

export function capped(items: readonly string[], cap = 5): Capped {
    if (items.length <= cap) return {shown: items, more: null};
    return {shown: items.slice(0, cap), more: 'and ' + (items.length - cap) + ' more'};
}

/** What Remove copy lists before it removes a copy with work in it. */
export interface DirtyView {
    readonly heading: string;
    /** Subject lines of the commits not on origin. */
    readonly commits: Capped;
    readonly commitsTitle: string | null;
    /** Paths with uncommitted changes. */
    readonly paths: Capped;
    readonly pathsTitle: string | null;
}

export function dirtyView(status: CopyStatus): DirtyView {
    return {
        heading: 'This copy has work that isn’t anywhere else.',
        commits: capped(status.unpushed.map((commit) => commit.subject)),
        commitsTitle: status.unpushed.length > 0 ? count(status.unpushed.length, 'commit') + ' not on origin' : null,
        paths: capped(status.uncommitted),
        pathsTitle: status.uncommitted.length > 0 ? count(status.uncommitted.length, 'uncommitted change') : null,
    };
}

/** The native confirm for a clean copy. */
export function removeConfirm(copyPath: string): string {
    return (
        'Remove the copy ' +
        projectLabel(copyPath) +
        '?\n\nIts folder on the VM is deleted. The local project stays as it is.'
    );
}

export const UNREACHABLE_REMOVE = 'Couldn’t reach the VM, so the copy wasn’t removed.';

/** One of a local project's copies, as the On VMs section links it. */
export interface CopyLink {
    readonly copyPath: string;
    readonly title: string;
    readonly host: string;
}

export function copyLinks(copies: readonly ProjectCopy[]): CopyLink[] {
    return copies.map((copy) => ({copyPath: copy.copyPath, title: projectLabel(copy.copyPath), host: copy.hostLabel}));
}

/** "Copy of switchboard", in a copy's header, linking back. */
export function originLine(origin: string): string {
    return 'Copy of ' + projectLabel(origin);
}

function count(n: number, noun: string): string {
    return n + ' ' + noun + (n === 1 ? '' : 's');
}
