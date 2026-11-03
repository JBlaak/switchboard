/**
 * The `git` command line behind the HandoffGit port (#276 stage 2).
 *
 * Like `GitCliWorkspace`, every call is `execFile('git', argv)` with no shell,
 * refs that start with `-` are refused, and reads run with
 * `GIT_OPTIONAL_LOCKS=0` so a status never rewrites the user's index. The
 * fetch, the branch questions it shares and the root and branch lookups are
 * `GitCliWorkspace`'s own, so both adapters fetch with the same refspec and
 * the same tool environment.
 *
 * The one subtle part is `patch`: `git diff --binary HEAD` alone leaves out
 * untracked files, and `git add -A` to include them would change what the user
 * has staged. So the patch is made in a temporary index: a copy of the user's
 * (so the add is quick and sees the same stat cache), pointed at with
 * `GIT_INDEX_FILE`, which also moves git's `index.lock` next to the copy.
 * The user's `.git/index` is never opened for writing.
 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {GitWrite} from '../../application/ports/git-workspace';
import type {
    BringBackWorktree,
    HandoffArtifact,
    HandoffFileBytes,
    HandoffGit,
} from '../../application/ports/handoff-git';
import {GitCliWorkspace} from './git-cli-workspace';

const TIMEOUT_MS = 60_000;

/** A worktree checkout runs the repository's filters (LFS), which may download. */
const CHECKOUT_TIMEOUT_MS = 120_000;

/** A bundle or a patch can be big; past this the hand-off is not the right tool anyway. */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

type Env = Record<string, string | undefined>;

interface GitRun {
    code: number | null;
    stdout: Buffer;
    stderr: string;
}

function run(cwd: string, args: readonly string[], env: Env, timeout = TIMEOUT_MS): Promise<GitRun> {
    return new Promise((resolve) => {
        execFile(
            'git',
            ['-C', cwd, ...args],
            {
                env: {...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'},
                timeout,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: 'buffer',
            },
            (err, stdout, stderr) => {
                const code = !err
                    ? 0
                    : typeof (err as {code?: unknown}).code === 'number'
                      ? (err as {code: number}).code
                      : null;
                resolve({
                    code,
                    stdout: stdout ?? Buffer.alloc(0),
                    stderr: (stderr ?? Buffer.alloc(0)).toString('utf8'),
                });
            },
        );
    });
}

/** git's last line on stderr, without its `fatal:`, for a reason the user reads. */
function reasonOf(result: GitRun): string {
    const lines = result.stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length ? lines[lines.length - 1].replace(/^(fatal|error):\s*/, '') : `git exited with ${result.code}`;
}

function isSafeRef(ref: string): boolean {
    return ref.length > 0 && !ref.startsWith('-');
}

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** A `-z` list split into its entries. */
function nulList(bytes: Buffer): string[] {
    return bytes.toString('utf8').split('\0').filter(Boolean);
}

/** `relative` resolved under `root`, or null when it would leave it. */
function inside(root: string, relative: string): string | null {
    if (!relative || path.isAbsolute(relative) || relative.includes('\0')) return null;
    const full = path.resolve(root, relative);
    return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

/** Where Switchboard (and `claude --worktree`) keeps a checkout's own worktrees, as a pathspec. */
const LOCAL_WORKTREES = '.claude/worktrees';

export class GitCliHandoff implements HandoffGit {
    private readonly workspace: GitCliWorkspace;

    /**
     * `toolEnv` is the environment the fetch and the checkout run in: the
     * login shell's, for the same reason as `GitCliWorkspace`'s (LFS off
     * Homebrew's PATH). The reads run in it too; they need nothing more.
     */
    constructor(private readonly toolEnv: () => Promise<Env> = async () => process.env) {
        this.workspace = new GitCliWorkspace(toolEnv);
    }

    public repositoryRoot(cwd: string): Promise<string | null> {
        return this.workspace.worktreeRoot(cwd);
    }

    public async commonDir(cwd: string): Promise<string | null> {
        const result = await run(
            cwd,
            ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            await this.toolEnv(),
        );
        return result.code === 0 ? result.stdout.toString('utf8').trim() || null : null;
    }

    public currentBranch(root: string): Promise<string | null> {
        return this.workspace.currentBranch(root);
    }

    public async headOid(root: string): Promise<string | null> {
        const result = await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], await this.toolEnv());
        return result.code === 0 ? result.stdout.toString('utf8').trim() || null : null;
    }

    public async originUrl(root: string): Promise<string | null> {
        const result = await run(root, ['remote', 'get-url', 'origin'], await this.toolEnv());
        return result.code === 0 ? result.stdout.toString('utf8').trim() || null : null;
    }

    public async unpushedCount(root: string): Promise<number> {
        const result = await run(
            root,
            ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'],
            await this.toolEnv(),
        );
        const count = result.code === 0 ? Number(result.stdout.toString('utf8').trim()) : 0;
        return Number.isFinite(count) ? count : 0;
    }

    public async bundle(root: string): Promise<HandoffArtifact | null> {
        // git refuses an empty bundle ("Refusing to create empty bundle"), so
        // nothing to carry is answered before it is asked.
        if ((await this.unpushedCount(root)) === 0) return null;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-handoff-'));
        const file = path.join(dir, 'handoff.bundle');
        try {
            const result = await run(
                root,
                ['bundle', 'create', '--quiet', file, 'HEAD', '--not', '--remotes=origin'],
                await this.toolEnv(),
            );
            if (result.code !== 0) return null;
            const bytes = fs.readFileSync(file);
            return {bytes, sha256: sha256(bytes)};
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    }

    public async patch(root: string): Promise<HandoffArtifact | null> {
        const env = await this.toolEnv();
        const indexPath = await this.gitPath(root, 'index', env);
        if (!indexPath) return null;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-handoff-'));
        const tempIndex = path.join(dir, 'index');
        try {
            // Without an index yet (nothing ever staged) git starts an empty one.
            if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, tempIndex);
            const withIndex = {...env, GIT_INDEX_FILE: tempIndex};
            // Switchboard's own worktrees live inside the checkout; in a repository
            // that does not ignore `.claude/` they would go over as embedded repos,
            // and the empty folders they leave on the VM block its worktrees.
            const added = await run(root, ['add', '-A', '--', '.', `:(exclude)${LOCAL_WORKTREES}`], withIndex);
            if (added.code !== 0) return null;
            // Any other repository nested in the checkout (not a submodule HEAD
            // already has) is left out the same way: a patch cannot carry it.
            const dropped = await this.dropNewGitlinks(root, withIndex);
            if (!dropped) return null;
            // The explicit prefixes beat a user's `diff.noprefix` or
            // `diff.mnemonicPrefix`, either of which would break `git apply` on the VM.
            const diff = await run(
                root,
                [
                    'diff',
                    '--cached',
                    '--binary',
                    '--no-color',
                    '--no-ext-diff',
                    '--no-textconv',
                    '--src-prefix=a/',
                    '--dst-prefix=b/',
                    'HEAD',
                ],
                withIndex,
            );
            if (diff.code !== 0 || diff.stdout.length === 0) return null;
            return {bytes: diff.stdout, sha256: sha256(diff.stdout)};
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    }

    public async uncommittedPaths(root: string): Promise<string[]> {
        const result = await run(
            root,
            [
                'status',
                '--porcelain=v1',
                '-z',
                '--untracked-files=all',
                '--no-renames',
                '--',
                '.',
                `:(exclude)${LOCAL_WORKTREES}`,
            ],
            await this.toolEnv(),
        );
        if (result.code !== 0) return [];
        // Each entry is `XY path`; with --no-renames there is never a second path.
        return nulList(result.stdout)
            .map((entry) => entry.slice(3))
            .filter(Boolean);
    }

    public async ignoredPaths(root: string): Promise<string[]> {
        const result = await run(
            root,
            ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
            await this.toolEnv(),
        );
        return result.code === 0 ? nulList(result.stdout) : [];
    }

    public async fileSizes(root: string, paths: readonly string[]): Promise<Map<string, number>> {
        const sizes = new Map<string, number>();
        for (const relative of paths) {
            const full = inside(root, relative);
            if (!full || !this.noSymlinkOnTheWay(root, relative)) continue;
            try {
                const stat = fs.lstatSync(full);
                if (stat.isFile()) sizes.set(relative, stat.size);
            } catch {
                // Gone since it was listed.
            }
        }
        return sizes;
    }

    public async readFile(root: string, relative: string): Promise<HandoffFileBytes | null> {
        const full = inside(root, relative);
        if (!full || !this.noSymlinkOnTheWay(root, relative)) return null;
        try {
            const stat = fs.lstatSync(full);
            if (!stat.isFile()) return null;
            return {bytes: fs.readFileSync(full), mode: stat.mode & 0o777};
        } catch {
            return null;
        }
    }

    public async fetchFromCopy(root: string, remote: string, url: string, branch: string): Promise<GitWrite> {
        if (!isSafeRef(branch) || !/^[A-Za-z0-9._-]+$/.test(remote) || url.startsWith('-')) {
            return {ok: false, reason: `Cannot fetch ${branch} from ${url}`};
        }
        const env = await this.toolEnv();
        const added = await run(root, ['remote', 'add', remote, url], env);
        if (added.code !== 0) {
            const reset = await run(root, ['remote', 'set-url', remote, url], env);
            if (reset.code !== 0) return {ok: false, reason: reasonOf(reset)};
        }
        const fetched = await run(
            root,
            ['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
            env,
            CHECKOUT_TIMEOUT_MS,
        );
        return fetched.code === 0 ? {ok: true} : {ok: false, reason: reasonOf(fetched)};
    }

    public async addWorktree(root: string, target: string, branch: string, base: string): Promise<BringBackWorktree> {
        if (!isSafeRef(branch) || !isSafeRef(base))
            return {ok: false, reason: 'Not a branch name: ' + branch, taken: false};
        const env = await this.toolEnv();
        const remote = base;
        const fail = (result: GitRun, taken = false): BringBackWorktree => ({
            ok: false,
            reason: reasonOf(result),
            taken,
        });

        // A worktree whose folder has gone still holds its branch until pruned.
        await run(root, ['worktree', 'prune'], env);

        if (!(await this.workspace.branchExists(root, branch))) {
            const added = await run(
                root,
                ['worktree', 'add', '--quiet', '--no-track', '-b', branch, target, remote],
                env,
                CHECKOUT_TIMEOUT_MS,
            );
            return added.code === 0 ? {ok: true} : fail(added);
        }

        const behind = await run(root, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, remote], env);
        if (behind.code !== 0)
            return {ok: false, reason: `${branch} has commits here that ${remote} does not`, taken: true};

        const checkedOut = await this.checkedOutAt(root, branch, env);
        if (checkedOut && path.resolve(checkedOut) === path.resolve(target)) {
            // Our own worktree from an earlier Bring back: catch it up in place.
            // git refuses when that would clobber changes made there since.
            const merged = await run(target, ['merge', '--ff-only', '--quiet', remote], env, CHECKOUT_TIMEOUT_MS);
            return merged.code === 0 ? {ok: true} : fail(merged, true);
        }
        if (checkedOut) return {ok: false, reason: `${branch} is checked out in ${checkedOut}`, taken: true};

        const moved = await run(root, ['branch', '--force', branch, remote], env);
        if (moved.code !== 0) return fail(moved);
        const added = await run(root, ['worktree', 'add', '--quiet', target, branch], env, CHECKOUT_TIMEOUT_MS);
        return added.code === 0 ? {ok: true} : fail(added);
    }

    /**
     * Unstage, in the temp index, every gitlink (a nested repository) that
     * HEAD does not have: `git add -A` stages one for each embedded repo.
     */
    private async dropNewGitlinks(root: string, withIndex: Env): Promise<boolean> {
        const staged = await run(root, ['ls-files', '-s', '-z'], withIndex);
        if (staged.code !== 0) return false;
        const links = nulList(staged.stdout)
            .filter((entry) => entry.startsWith('160000 '))
            .map((entry) => entry.slice(entry.indexOf('\t') + 1));
        if (links.length === 0) return true;
        const inHead = await run(root, ['ls-tree', '-r', '-z', 'HEAD', '--', ...links], withIndex);
        const known = new Set(
            inHead.code === 0
                ? nulList(inHead.stdout)
                      .filter((entry) => entry.startsWith('160000 '))
                      .map((entry) => entry.slice(entry.indexOf('\t') + 1))
                : [],
        );
        const fresh = links.filter((link) => !known.has(link));
        if (fresh.length === 0) return true;
        const removed = await run(root, ['update-index', '--force-remove', '--', ...fresh], withIndex);
        return removed.code === 0;
    }

    /** Where `branch` is checked out among the repository's worktrees; null when nowhere. */
    private async checkedOutAt(root: string, branch: string, env: Env): Promise<string | null> {
        const result = await run(root, ['worktree', 'list', '--porcelain', '-z'], env);
        if (result.code !== 0) return null;
        let current: string | null = null;
        for (const line of nulList(result.stdout)) {
            if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
            else if (line === `branch refs/heads/${branch}`) return current;
        }
        return null;
    }

    /** `git rev-parse --git-path`, absolute: in a linked worktree the index is not under `<root>/.git`. */
    private async gitPath(root: string, name: string, env: Env): Promise<string | null> {
        const result = await run(root, ['rev-parse', '--path-format=absolute', '--git-path', name], env);
        return result.code === 0 ? result.stdout.toString('utf8').trim() || null : null;
    }

    /** No folder between `root` and `relative` is a symlink, so a read cannot be led outside the checkout. */
    private noSymlinkOnTheWay(root: string, relative: string): boolean {
        const segments = relative.split('/');
        let at = root;
        for (const segment of segments.slice(0, -1)) {
            at = path.join(at, segment);
            try {
                if (fs.lstatSync(at).isSymbolicLink()) return false;
            } catch {
                return false;
            }
        }
        return true;
    }
}
