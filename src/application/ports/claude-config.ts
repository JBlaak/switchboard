/**
 * The pieces the global config copy (#283) needs from outside: the Mac's
 * `~/.claude` to read from, the record of what was last copied to each host,
 * and the agent connection to send through.
 *
 * Separate from `FileSystem` because the copy needs what that port leaves
 * out on purpose: bytes rather than UTF-8, file modes, and a recursive
 * listing. Narrow so a test can hand the service an in-memory `~/.claude`.
 */
import type {ConfigCopyManifest, ConfigEntry} from '../../domain/agent/config-copy';
import type {ConfigFile} from '../../domain/agent/protocol';

/** The Mac's `~/.claude`, read only. Every path is relative to it and `/`-separated. */
export interface ClaudeConfigSource {
    /** The Mac's absolute home, e.g. `/Users/name`, to recognise the absolute paths in plugin records. */
    readonly homeDir: string;
    /**
     * Every regular file below `folder`, recursively, with paths relative to
     * `~/.claude`; empty when the folder is missing. Symlinks are followed (a
     * skill is often a link to a checkout) and reported under the link's own
     * path; loops and unreadable entries are left out. The adapter may skip
     * folders `isExcludedName` names instead of walking them.
     */
    list(folder: string): ConfigEntry[];
    /** One file's entry, or null when it is missing or not a regular file. */
    stat(path: string): ConfigEntry | null;
    /** A file's bytes. Throws when it cannot be read. */
    read(path: string): Uint8Array;
}

/**
 * What the last successful copy to each host wrote, keyed by the host's
 * `user@host:port`. Kept on the Mac, so that a file deleted on the Mac can be
 * deleted on the VM too; `manifestStoreOn` in the service keeps it in the
 * settings store.
 */
export interface ConfigManifestStore {
    get(hostKey: string): ConfigCopyManifest | null;
    set(hostKey: string, manifest: ConfigCopyManifest): void;
}

/** The answer to a `copy-config`, the agent's `done`. */
export interface ConfigCopyReply {
    ok: boolean;
    error?: string;
}

/**
 * The open link to one host's agent, as far as the copy needs it. The agent
 * connection supplies it: it adds the `type` and a `requestId`, sends a
 * `copy-config` and resolves with the matching `done`; it rejects (or
 * answers `ok: false`) when the link closes first.
 */
export interface ConfigCopyConnection {
    copyConfig(request: {files: ConfigFile[]; removed: string[]}): Promise<ConfigCopyReply>;
}
