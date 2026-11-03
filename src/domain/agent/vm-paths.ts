/**
 * Naming a VM's folders and transcript folders on the Mac (#276 stage 4).
 *
 * The Mac's services key everything by path: a project, a worktree, a file in
 * it. A VM's paths go through them in the same `ssh://` form a remote project
 * already has, with the VM's absolute path as the folder:
 * `ssh://user@host[:port]//home/dev/projects/site` (`~` paths keep their `~`).
 * The git and transcript adapters split that back into a host and a VM path,
 * and every path they hand back goes the other way, so a service can feed one
 * answer into the next call without ever learning that it is on a VM.
 *
 * Transcript folders are names, not paths: a VM's is
 * `vm:<user>@<host>:<port>:<encoded>`, where `<encoded>` is the folder's name
 * under the VM's `~/.claude/projects`.
 */
import {parseRemoteProjectPath, remoteProjectPath} from '../project/remote-target';

/** A VM host, as these names identify it. */
export interface VmHost {
    user: string;
    host: string;
    port: number;
}

/** `path` on `host`, as the Mac's services name it. */
export function vmPath(host: VmHost, path: string): string {
    return remoteProjectPath({...host, dir: path});
}

/** The host and VM path a name stands for; null for a local path. A host's home is `~`. */
export function splitVmPath(name: string): {host: VmHost; path: string} | null {
    const parsed = parseRemoteProjectPath(name);
    if (!parsed) return null;
    return {host: {user: parsed.user, host: parsed.host, port: parsed.port}, path: parsed.dir ?? '~'};
}

/** `user@host:port`, the key a host goes by in folder names. */
export function vmHostKey(host: VmHost): string {
    return `${host.user}@${host.host}:${host.port}`;
}

const VM_FOLDER = /^vm:([^@:]+)@([^:]+):(\d+):(.+)$/;

/** A VM transcript folder's name on the Mac. */
export function vmFolder(host: VmHost, encoded: string): string {
    return `vm:${vmHostKey(host)}:${encoded}`;
}

export function isVmFolder(folder: string | null | undefined): boolean {
    return !!folder && VM_FOLDER.test(folder);
}

/** The host and VM folder name a transcript folder stands for; null for a local one. */
export function splitVmFolder(folder: string): {host: VmHost; encoded: string} | null {
    const m = VM_FOLDER.exec(folder);
    return m ? {host: {user: m[1], host: m[2], port: Number(m[3])}, encoded: m[4]} : null;
}

/** A VM's own address as the per-host calls take it: `ssh://user@host[:port]`, no folder. */
export function vmHostPath(host: VmHost): string {
    return remoteProjectPath({...host, dir: null});
}

/** The host a `user@host:port` key names; null for anything else. */
export function parseVmHostKey(key: string): VmHost | null {
    const m = /^([^@:]+)@([^:]+):(\d+)$/.exec(key);
    return m ? {user: m[1], host: m[2], port: Number(m[3])} : null;
}
