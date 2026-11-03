/**
 * GitCliWorkspace's runner for one VM: git, file reads and watches through
 * that host's agent (#276 stage 4).
 *
 * The Mac's project page, session work page and Plan tab read git through
 * GitCliWorkspace; given this runner, the same parsers read a VM's checkout.
 * Every working directory and path it is handed is a name
 * (`ssh://user@host//abs`, `domain/agent/vm-paths`); it splits that, expands a
 * leading `~` with the home folder the agent's `welcome` said, and sends the
 * agent the absolute VM path its requests take. Every path git prints goes
 * back the other way through `fromHost`, so a service can feed one answer into
 * the next call.
 *
 * What differs from a local run, and why:
 * - git gets `--no-optional-locks` as a global option: the same promise as the
 *   local runner's `GIT_OPTIONAL_LOCKS=0` (no index refresh written back),
 *   which `run-tool` has no environment field to carry.
 * - Output past the agent's cap (`TOOL_OUTPUT_CAP_BYTES`) comes back cut; a
 *   cut diff would parse as a wrong one, so it counts as a failed run, as the
 *   local runner's `maxBuffer` overflow does.
 * - A link that is down, or a path on another host, answers `code: null`
 *   rather than rejecting: the port's readers turn that into "nothing there",
 *   as they do for a git that is not installed.
 * - A working file is checked to be inside the worktree by its normalized
 *   path, and to be a plain file by `stat-files` (which never follows a
 *   symlink); the agent's `read-file` is trusted to read only what it is
 *   asked. The Mac cannot `realpath` on the VM, so a symlinked *directory*
 *   inside the worktree is the agent's to refuse.
 */
import * as path from 'node:path';
import {splitVmPath, vmHostKey, vmPath} from '../../domain/agent/vm-paths';
import type {VmHost} from '../../domain/agent/vm-paths';
import {TOOL_OUTPUT_CAP_BYTES} from '../../domain/agent/protocol';
import type {AgentToolName} from '../../domain/agent/protocol';
import type {Disposable} from '../../application/ports/git-workspace';
import type {GitRun, GitRunner, GitRunOptions} from './git-runner';

/**
 * What this runner needs of a host's agent connection: the stage 4 requests
 * and the home its `welcome` carried. AgentConnection is one; a narrow shape
 * keeps this adapter from depending on the client's whole class.
 */
export interface AgentTools {
    /** The agent user's home folder; null before a `welcome`, or from an older agent. */
    readonly home: string | null;
    whenConnected(): Promise<void>;
    runTool(
        tool: AgentToolName,
        cwd: string,
        args: readonly string[],
        options: {stdin?: string | Uint8Array; timeoutMs: number},
    ): Promise<{code: number; stdout: Uint8Array; stderr: string; truncated: boolean}>;
    readFile(path: string, maxBytes: number): Promise<Uint8Array | null>;
    statFiles(paths: readonly string[]): Promise<Map<string, number>>;
    watchDir(dir: string, onChange: () => void): Disposable;
}

const posix = path.posix;

function asBuffer(bytes: Uint8Array): Buffer {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function failed(error: string): GitRun {
    return {code: null, stdout: Buffer.alloc(0), stderr: '', error};
}

export class VmGitRunner implements GitRunner {
    private readonly key: string;

    /**
     * `tools` is asked for on every call, not once: the client owns the
     * connection and may replace it (a reinstall), and this runner should
     * always talk to the current one.
     */
    constructor(
        private readonly host: VmHost,
        private readonly tools: () => AgentTools,
    ) {
        this.key = vmHostKey(host);
    }

    public async git(cwd: string, args: readonly string[], {input, timeoutMs}: GitRunOptions): Promise<GitRun> {
        try {
            const dir = await this.resolve(cwd);
            const run = await this.tools().runTool('git', dir, ['--no-optional-locks', ...args], {
                timeoutMs,
                ...(input !== undefined ? {stdin: input} : {}),
            });
            if (run.truncated) return {...failed('git printed more than the agent sends'), stderr: run.stderr};
            if (run.code === -1) return {...failed(run.stderr || 'git did not run on the VM'), stderr: run.stderr};
            return {code: run.code, stdout: asBuffer(run.stdout), stderr: run.stderr};
        } catch (err) {
            return failed((err as Error).message);
        }
    }

    public async workingFileSizes(worktree: string, files: readonly string[]): Promise<Map<string, number>> {
        const sizes = new Map<string, number>();
        try {
            const root = await this.resolve(worktree);
            const asked = new Map<string, string>();
            for (const file of files) {
                const full = inside(root, file);
                if (full) asked.set(full, file);
            }
            if (asked.size === 0) return sizes;
            const stats = await this.tools().statFiles([...asked.keys()]);
            for (const [full, file] of asked) {
                const size = stats.get(full);
                if (size !== undefined) sizes.set(file, size);
            }
        } catch {
            // The link is down: no sizes, as for files that are not there.
        }
        return sizes;
    }

    public async workingFile(worktree: string, file: string, maxBytes: number): Promise<Uint8Array | null> {
        try {
            const full = inside(await this.resolve(worktree), file);
            if (!full) return null;
            const limit = Math.min(maxBytes, TOOL_OUTPUT_CAP_BYTES);
            // Asked first so a symlink is never read through.
            const size = (await this.tools().statFiles([full])).get(full);
            if (size === undefined || size > limit) return null;
            return await this.tools().readFile(full, limit);
        } catch {
            return null;
        }
    }

    public watch(worktree: string, onChange: () => void): Disposable {
        let disposed = false;
        let watching: Disposable | null = null;
        // Resolving a `~` path waits for the link (its `welcome` says the home),
        // so the agent's watch starts once that is known.
        void this.resolve(worktree).then(
            (dir) => {
                if (!disposed) watching = this.tools().watchDir(dir, onChange);
            },
            () => {
                // Not a path on this host, or no home: nothing to watch, as
                // locally for a folder that is not a repository.
            },
        );
        return {
            dispose() {
                disposed = true;
                watching?.dispose();
                watching = null;
            },
        };
    }

    public toHost(name: string): string | null {
        const split = this.split(name);
        if (!split) return null;
        if (split.startsWith('/')) return normalize(split);
        const home = this.tools().home;
        return home ? expand(split, home) : null;
    }

    public fromHost(hostPath: string): string {
        return vmPath(this.host, hostPath);
    }

    /** The VM path a name stands for, `~` and all; null when it is not on this host. */
    private split(name: string): string | null {
        const split = splitVmPath(name);
        return split && vmHostKey(split.host) === this.key ? split.path : null;
    }

    /** The absolute VM path a name stands for, waiting for the link when the home is needed. */
    private async resolve(name: string): Promise<string> {
        const split = this.split(name);
        if (split === null) throw new Error(`not a path on ${this.key}: ${name}`);
        if (split.startsWith('/')) return normalize(split);
        const tools = this.tools();
        if (tools.home === null) await tools.whenConnected();
        if (tools.home === null) {
            throw new Error(`the agent on ${this.key} did not say where its home folder is; reinstall the agent`);
        }
        return expand(split, tools.home);
    }
}

/** A VM path without a trailing slash (but `/` stays `/`). */
function normalize(abs: string): string {
    const normal = posix.normalize(abs);
    return normal.length > 1 ? normal.replace(/\/+$/, '') : normal;
}

/**
 * A `~`, `~/…` or relative VM path made absolute with `home`. A bare relative
 * path is under the home too, as it is for a remote project's folder
 * (`expandRemoteDir`).
 */
function expand(relative: string, home: string): string {
    const rest = relative === '~' ? '' : relative.startsWith('~/') ? relative.slice(2) : relative;
    return normalize(posix.join(home, rest));
}

/** `file` under `root`, when it is a relative path that stays inside it; null otherwise. */
function inside(root: string, file: string): string | null {
    if (file.length === 0 || posix.isAbsolute(file)) return null;
    const full = posix.join(root, file);
    return full.startsWith(root === '/' ? '/' : root + '/') && full !== root ? full : null;
}
