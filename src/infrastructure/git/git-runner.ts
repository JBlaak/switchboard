/**
 * Where GitCliWorkspace's git commands, file reads and watches run (#276 stage 4).
 *
 * GitCliWorkspace knows which git commands answer the GitWorkspace port and
 * how to read their output; a GitRunner knows where they run. The local one
 * (`LocalGitRunner`) runs them on this Mac exactly as GitCliWorkspace always
 * has. The VM one (`VmGitRunner`, in `vm-git-runner.ts`) runs them on a VM
 * through its agent. Keeping every `execFile` and `fs` call behind this seam
 * is what lets one parser of `git status` or `git worktree list` serve both.
 *
 * Paths cross the seam in two forms. The ones a service hands in and gets back
 * are *names*: a local path as it is, a VM path as `ssh://user@host//abs`
 * (`domain/agent/vm-paths`). The ones git takes as arguments and prints are
 * *host paths*: what the machine running git calls that folder. A working
 * directory (`cwd`, `worktree`) is always a name, and the runner resolves it
 * itself; for any other path GitCliWorkspace passes to git or reads from its
 * output, it asks `toHost` and `fromHost`. Both are the identity locally.
 */
import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {Disposable} from '../../application/ports/git-workspace';

/** Diffs can be large; anything past this is a diff nobody will read on one page anyway. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** How long a read-only git command may take. */
export const TIMEOUT_MS = 15_000;

/** How long `watch` waits for a burst of writes (a commit touches several files) to settle. */
const WATCH_DEBOUNCE_MS = 100;

/** What running git produced. */
export interface GitRun {
    /** null when git could not be started, was killed, or its output was cut. */
    code: number | null;
    stdout: Buffer;
    stderr: string;
    /** Why git did not run or failed, when it says nothing on stderr itself. */
    error?: string;
}

export interface GitRunOptions {
    /** Written to git's stdin. */
    input?: string;
    timeoutMs: number;
    /**
     * A command that changes something (fetch, worktree add/remove): it runs in
     * the tool environment, where the repository's filters (`git-lfs`) are on
     * PATH, and never waits on a credential prompt nobody can see.
     */
    write?: boolean;
}

export interface GitRunner {
    /** Run `git -C <cwd's host path> …args`. Never rejects: a git that cannot run answers `code: null`. */
    git(cwd: string, args: readonly string[], options: GitRunOptions): Promise<GitRun>;

    /**
     * The sizes of those repository-relative paths that are plain files inside
     * `worktree`: not symlinks, and not reached through `..` or a symlinked
     * directory. Others are left out.
     */
    workingFileSizes(worktree: string, files: readonly string[]): Promise<Map<string, number>>;

    /** A plain file's bytes inside `worktree` (as for `workingFileSizes`); null otherwise, or past `maxBytes`. */
    workingFile(worktree: string, file: string, maxBytes: number): Promise<Uint8Array | null>;

    /** Call `onChange` (debounced) when the worktree's HEAD, index or refs change. */
    watch(worktree: string, onChange: () => void): Disposable;

    /** The path git on the runner's machine knows a name by; null when the name is not on that machine. */
    toHost(name: string): string | null;

    /** The name of a path git printed. */
    fromHost(hostPath: string): string;
}

const READ_ENV = {...process.env, GIT_OPTIONAL_LOCKS: '0'};

function exitCode(err: Error | null): number | null {
    if (!err) return 0;
    const code = (err as {code?: unknown}).code;
    return typeof code === 'number' ? code : null;
}

/**
 * git on this Mac: `execFile('git', ['-C', cwd, …args])`, no shell, with
 * `GIT_OPTIONAL_LOCKS=0` (see GitCliWorkspace), and the file reads and watches
 * straight off the disk. Names are paths here, so `toHost`/`fromHost` change
 * nothing.
 */
export class LocalGitRunner implements GitRunner {
    /**
     * `toolEnv` is the environment the writes run in. Launched from the Finder
     * the app's PATH has no Homebrew, and a checkout runs the repository's
     * filters (`git-lfs`) off that PATH: without it git fails "the remote end
     * hung up unexpectedly".
     */
    constructor(
        private readonly toolEnv: () => Promise<Record<string, string | undefined>> = async () => process.env,
    ) {}

    public async git(cwd: string, args: readonly string[], {input, timeoutMs, write}: GitRunOptions): Promise<GitRun> {
        const env = write ? {...(await this.toolEnv()), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'} : READ_ENV;
        return new Promise((resolve) => {
            const child = execFile(
                'git',
                ['-C', cwd, ...args],
                {timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env, encoding: 'buffer'},
                (err, stdout, stderr) => {
                    resolve({
                        code: exitCode(err),
                        stdout: stdout ?? Buffer.alloc(0),
                        stderr: stderr?.toString('utf8') ?? '',
                        ...(err ? {error: err.message} : {}),
                    });
                },
            );
            if (input !== undefined) child.stdin?.end(input);
        });
    }

    public async workingFileSizes(worktree: string, files: readonly string[]): Promise<Map<string, number>> {
        const sizes = new Map<string, number>();
        for (const file of files) {
            const full = await workingFilePath(worktree, file);
            if (!full) continue;
            try {
                sizes.set(file, (await fs.promises.lstat(full)).size);
            } catch {
                // Gone since it was checked: left out like any missing file.
            }
        }
        return sizes;
    }

    public async workingFile(worktree: string, file: string, maxBytes: number): Promise<Uint8Array | null> {
        const full = await workingFilePath(worktree, file);
        if (!full) return null;
        try {
            if ((await fs.promises.lstat(full)).size > maxBytes) return null;
            return await fs.promises.readFile(full);
        } catch {
            return null;
        }
    }

    public watch(worktree: string, onChange: () => void): Disposable {
        const dirs = gitDirs(worktree);
        const watchers: fs.FSWatcher[] = [];
        let timer: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;

        const notify = () => {
            if (disposed || timer) return;
            timer = setTimeout(() => {
                timer = null;
                if (!disposed) onChange();
            }, WATCH_DEBOUNCE_MS);
        };
        const tryWatch = (target: string, recursive: boolean): boolean => {
            try {
                const watcher = fs.watch(target, {recursive}, notify);
                // A watched directory that goes away (the worktree was removed) is
                // not worth crashing over; it simply stops reporting.
                watcher.on('error', () => watcher.close());
                watchers.push(watcher);
                return true;
            } catch {
                return false;
            }
        };

        if (dirs) {
            // HEAD and index live in the worktree's own git dir, which for a linked
            // worktree is `.git/worktrees/<name>`; refs are shared with the main
            // checkout and live in the common dir.
            tryWatch(dirs.gitDir, false);
            const refs = path.join(dirs.commonDir, 'refs');
            if (!tryWatch(refs, true)) tryWatch(path.join(refs, 'heads'), false);
        }

        return {
            dispose() {
                disposed = true;
                if (timer) clearTimeout(timer);
                timer = null;
                for (const watcher of watchers) watcher.close();
                watchers.length = 0;
            },
        };
    }

    public toHost(name: string): string {
        return name;
    }

    public fromHost(hostPath: string): string {
        return hostPath;
    }
}

/**
 * Where a repository-relative path is on disk, when it is a plain file inside
 * the worktree: not a symlink, and not somewhere a `..` or a symlinked
 * directory would lead out of it. null otherwise.
 */
async function workingFilePath(worktree: string, file: string): Promise<string | null> {
    if (file.length === 0 || path.isAbsolute(file)) return null;
    const full = path.resolve(worktree, file);
    try {
        if (!(await fs.promises.lstat(full)).isFile()) return null;
        const [realRoot, realFile] = await Promise.all([fs.promises.realpath(worktree), fs.promises.realpath(full)]);
        return realFile.startsWith(realRoot + path.sep) ? full : null;
    } catch {
        return null;
    }
}

/**
 * A worktree's own git dir and the common dir it shares with the main checkout.
 *
 * Read off disk rather than asked of git, so `watch` can answer at once: in a
 * linked worktree `.git` is a file saying `gitdir: <path>`, and that directory
 * holds a `commondir` file pointing back at the main `.git`.
 */
function gitDirs(worktree: string): {gitDir: string; commonDir: string} | null {
    const dotGit = path.join(worktree, '.git');
    try {
        if (fs.statSync(dotGit).isDirectory()) return {gitDir: dotGit, commonDir: dotGit};
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!pointer) return null;
        const gitDir = path.resolve(worktree, pointer[1].trim());
        let commonDir = gitDir;
        try {
            commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        } catch {
            // No `commondir`: a separate git dir that is its own common dir.
        }
        return {gitDir, commonDir};
    } catch {
        return null;
    }
}
