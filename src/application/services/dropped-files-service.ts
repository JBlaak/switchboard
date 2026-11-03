/**
 * Files dropped on a VM session's terminal (#276 stage 5, story 40), behind
 * the `DroppedFiles` façade.
 *
 * A local terminal is handed the dropped file's path, which the shell or
 * Claude then reads. Typed into a VM session, that Mac path names nothing, so
 * each file is carried over first:
 *
 * 1. **Check the session** is a running VM session: its PTY is the agent
 *    client's stand-in (`AgentPty`). A local or legacy ssh+tmux session is
 *    refused; the renderer pastes its own paths there, as before.
 * 2. **Read every file** before anything is sent: a regular file of at most
 *    `DROPPED_FILE_CAP_BYTES`. One that is missing, a folder, or too large
 *    fails the whole drop, so a drop never types half its paths.
 * 3. **Upload and place** each, in the order dropped: `upload` (chunked, its
 *    SHA-256 checked by the agent), then `place-upload` under the file's own
 *    name, which answers where the agent put it on the VM.
 *
 * The answer is the VM paths in the order of `localPaths`, for the renderer to
 * type as it would have typed the local ones. Hashing and reading the disk
 * are ports, as in the session hand-off, so the application layer stays free
 * of `node:`.
 */
import {parseRemoteProjectPath} from '../../domain/project/remote-target';
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {PtyHandle} from '../ports/terminal-gateway';
import type {Logger} from '../ports/logger';
import {isAgentPty} from './agent-client/agent-pty';
import {DROPPED_FILE_CAP_BYTES, type DroppedFiles} from './dropped-files';

/** A running session, as far as a drop reads it. */
export interface DropSessionView {
    readonly pty: PtyHandle;
    readonly projectPath: string;
    readonly exited: boolean;
}

/** The agent link, as far as carrying a dropped file needs it (an `AgentConnection` is one). */
export interface DropCarrier {
    upload(bytes: Uint8Array, options: {sha256: string}): Promise<string>;
    /** Send `place-upload` and answer its `placed`. */
    placeUpload(uploadId: string, name: string): Promise<{ok: boolean; path?: string; error?: string}>;
}

/** The Mac's disk, as far as a drop reads it. */
export interface DropFileReader {
    /** The file's kind and size; null when nothing is there or it cannot be read. */
    stat(path: string): {isFile: boolean; size: number} | null;
    /** The whole file; throws when it cannot be read. */
    read(path: string): Uint8Array;
    /** The last segment of a local path: the name the file keeps on the VM. */
    basename(path: string): string;
}

export interface DroppedFilesServiceDeps {
    /** The running sessions (the `SessionRegistry`). */
    registry: {find(sessionId: string): {key: string; session: DropSessionView} | null};
    /** The link to a VM's agent (the `AgentClient`). */
    agents: {connection(host: RemoteConfig): DropCarrier};
    files: DropFileReader;
    /** SHA-256 of the bytes, hex, for the agent to check the upload against. */
    sha256(bytes: Uint8Array): string;
    log: Logger;
    /** The largest file a drop carries; `DROPPED_FILE_CAP_BYTES` unless a test says otherwise. */
    capBytes?: number;
}

export class DroppedFilesService implements DroppedFiles {
    constructor(private readonly deps: DroppedFilesServiceDeps) {}

    public async toSession(
        sessionId: string,
        localPaths: string[],
    ): Promise<{ok: true; paths: string[]} | {ok: false; error: string}> {
        const {registry, agents, files, sha256, log} = this.deps;
        const found = registry.find(sessionId);
        if (!found || found.session.exited) return {ok: false, error: 'That session is not running.'};
        const {session} = found;
        const host = parseRemoteProjectPath(session.projectPath);
        if (!isAgentPty(session.pty) || !host) return {ok: false, error: 'That session is not on a VM.'};

        const cap = this.deps.capBytes ?? DROPPED_FILE_CAP_BYTES;
        const read: {name: string; bytes: Uint8Array}[] = [];
        for (const path of localPaths) {
            const name = files.basename(path);
            const stat = files.stat(path);
            if (!stat) return {ok: false, error: `${name} could not be read.`};
            if (!stat.isFile) return {ok: false, error: `${name} is not a file; only files can be dropped on a VM.`};
            if (stat.size > cap) return {ok: false, error: `${name} is larger than ${formatMb(cap)}.`};
            let bytes: Uint8Array;
            try {
                bytes = files.read(path);
            } catch (err) {
                return {ok: false, error: `${name} could not be read: ${(err as Error).message}`};
            }
            // The file may have grown between the stat and the read.
            if (bytes.length > cap) return {ok: false, error: `${name} is larger than ${formatMb(cap)}.`};
            read.push({name: safeName(name), bytes});
        }

        const connection = agents.connection({user: host.user, host: host.host, port: host.port});
        const paths: string[] = [];
        for (const {name, bytes} of read) {
            try {
                const uploadId = await connection.upload(bytes, {sha256: sha256(bytes)});
                const placed = await connection.placeUpload(uploadId, name);
                if (!placed.ok || !placed.path) {
                    return {ok: false, error: `The VM did not take ${name}: ${placed.error || 'no path came back'}`};
                }
                paths.push(placed.path);
            } catch (err) {
                return {ok: false, error: `${name} could not be sent to the VM: ${(err as Error).message}`};
            }
        }
        log.info(`[drop] ${paths.length} file(s) to ${sessionId} on ${host.user}@${host.host}`);
        return {ok: true, paths};
    }
}

/**
 * The file's name as one safe segment for the agent: no slashes, no control
 * characters, and never `.` or `..`, which would name a folder.
 */
export function safeName(name: string): string {
    // eslint-disable-next-line no-control-regex
    const cleaned = name.replace(/[/\\\x00-\x1f\x7f]/g, '_').trim();
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

/** The cap as the error says it: in MB, or in bytes below one. */
function formatMb(bytes: number): string {
    const mb = 1024 * 1024;
    return bytes >= mb ? `${Math.round(bytes / mb)} MB` : `${bytes} bytes`;
}
