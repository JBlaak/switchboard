/**
 * The `git` command line behind the GitWorkspace port.
 *
 * Every call is `execFile('git', argv)`: no shell, so a branch or path with
 * spaces or quotes in it is one argument and nothing more. A ref that starts
 * with `-` is refused outright rather than passed, so it can never be read as
 * an option.
 *
 * Where the commands run is a GitRunner's business (`git-runner.ts`): on this
 * Mac by default, or on a VM through its agent (#276 stage 4). Paths a service
 * hands in and gets back are names (`ssh://user@host//abs` for a VM); every
 * path this class passes to git besides the working directory goes through
 * `runner.toHost`, and every path it hands back from git's output through
 * `runner.fromHost`, so a VM worktree's root, main checkout and worktree list
 * come back as names the next call takes. Locally both are the identity.
 *
 * Each command runs with `GIT_OPTIONAL_LOCKS=0`. Without it `git status` and
 * `git diff` refresh the index and write it back, which is a write Switchboard
 * promised not to make (A1) — and one `watch` would see, report, and cause
 * another read, round and round.
 */
import * as path from 'node:path';
import type {FileChange, FileStatus, LineStats} from '../../domain/session-work/model';
import type {WorktreeSummary} from '../../domain/project/overview';
import type {Disposable, GitWorkspace, GitWorktrees, GitWrite} from '../../application/ports/git-workspace';
import {LocalGitRunner, MAX_OUTPUT_BYTES, TIMEOUT_MS} from './git-runner';
import type {GitRunner} from './git-runner';

/** git's well-known empty tree: what a repository with no commits yet is diffed against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** How many paths go to one `git check-attr`, to stay well under the argv limit. */
const CHECK_ATTR_CHUNK = 200;

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];

interface GitResult {
    /** null when git could not be started, or was killed. */
    code: number | null;
    stdout: string;
}

/** The environment a local runner's writes run in. */
type ToolEnv = () => Promise<Record<string, string | undefined>>;

/** A ref safe to pass as an argument: not empty, and not something git would read as an option. */
function isSafeRef(ref: string): boolean {
    return ref.length > 0 && !ref.startsWith('-');
}

export class GitCliWorkspace implements GitWorkspace, GitWorktrees {
    private readonly runner: GitRunner;

    /**
     * Either the runner to use, or the tool environment of a local one: the
     * environment the fetch and the worktree checkout run in. Launched from the
     * Finder the app's PATH has no Homebrew, and a checkout runs the
     * repository's filters (`git-lfs`) off that PATH: without it git fails "the
     * remote end hung up unexpectedly".
     */
    constructor(runnerOrToolEnv: GitRunner | ToolEnv = async () => process.env) {
        this.runner = typeof runnerOrToolEnv === 'function' ? new LocalGitRunner(runnerOrToolEnv) : runnerOrToolEnv;
    }

    /** Run a read-only git, with `input` written to its stdin when given. */
    private async git(cwd: string, args: readonly string[], input?: string): Promise<GitResult> {
        const run = await this.runner.git(cwd, args, {timeoutMs: TIMEOUT_MS, ...(input !== undefined ? {input} : {})});
        return {code: run.code, stdout: run.stdout.toString('utf8')};
    }

    /** Run git for its raw output bytes; null when it did not succeed. */
    private async gitBytes(cwd: string, args: readonly string[]): Promise<Buffer | null> {
        const run = await this.runner.git(cwd, args, {timeoutMs: TIMEOUT_MS});
        return run.code === 0 ? run.stdout : null;
    }

    /** Run a git command that changes something, answering git's own last word when it fails. */
    private async gitWrite(cwd: string, args: readonly string[], timeoutMs: number): Promise<GitWrite> {
        const run = await this.runner.git(cwd, args, {timeoutMs, write: true});
        if (run.code === 0) return {ok: true};
        const said = run.stderr
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        const reason = said.length
            ? said[said.length - 1].replace(/^(fatal|error):\s*/, '')
            : run.error || 'git failed';
        return {ok: false, reason};
    }

    /** A worktree path argument as git on the runner's machine knows it; null when it is somewhere else. */
    private hostPath(name: string): string | null {
        return this.runner.toHost(name);
    }

    public async worktreeRoot(cwd: string): Promise<string | null> {
        const result = await this.git(cwd, ['rev-parse', '--show-toplevel']);
        const root = result.code === 0 ? result.stdout.trim() : '';
        return root ? this.runner.fromHost(root) : null;
    }

    public async defaultBranch(worktree: string): Promise<string> {
        const head = await this.git(worktree, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
        const fromOrigin = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : '';
        if (fromOrigin) return fromOrigin;

        const refs = await this.git(worktree, [
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads/main',
            'refs/heads/master',
            'refs/remotes/origin/main',
            'refs/remotes/origin/master',
        ]);
        const names = refs.code === 0 ? refs.stdout.split('\n').filter(Boolean) : [];
        if (names.some((name) => name.endsWith('/main'))) return 'main';
        if (names.some((name) => name.endsWith('/master'))) return 'master';
        return 'main';
    }

    public async currentBranch(worktree: string): Promise<string | null> {
        const result = await this.git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        return result.code === 0 ? result.stdout.trim() || null : null;
    }

    public async commitSha(worktree: string, ref: string): Promise<string | null> {
        if (!isSafeRef(ref)) return null;
        const result = await this.git(worktree, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
        return result.code === 0 ? result.stdout.trim() || null : null;
    }

    public async branchExists(worktree: string, branch: string): Promise<boolean> {
        if (!isSafeRef(branch)) return false;
        const result = await this.git(worktree, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
        return result.code === 0;
    }

    public async isPushed(worktree: string, branch: string): Promise<boolean> {
        if (!isSafeRef(branch)) return false;
        const upstream = await this.git(worktree, [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${branch}@{upstream}`,
        ]);
        if (upstream.code === 0) return true;
        const origin = await this.git(worktree, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/' + branch]);
        return origin.code === 0;
    }

    public async aheadBehind(worktree: string, branch: string, base: string): Promise<{ahead: number; behind: number}> {
        if (!isSafeRef(branch) || !isSafeRef(base)) return {ahead: 0, behind: 0};
        // Left is what only `base` has, right what only `branch` has.
        const result = await this.git(worktree, ['rev-list', '--left-right', '--count', `${base}...${branch}`, '--']);
        const [behind, ahead] = result.code === 0 ? result.stdout.trim().split(/\s+/).map(Number) : [0, 0];
        return {ahead: ahead || 0, behind: behind || 0};
    }

    public async branchDiff(worktree: string, branch: string, base: string): Promise<string> {
        if (!isSafeRef(branch) || !isSafeRef(base)) return '';
        // `a...b` in `git diff` is the diff from their merge-base to `b`.
        const result = await this.git(worktree, ['diff', ...DIFF_FLAGS, `${base}...${branch}`, '--']);
        return result.code === 0 ? result.stdout : '';
    }

    public async branchLineStats(worktree: string, branch: string, base: string): Promise<LineStats> {
        if (!isSafeRef(branch) || !isSafeRef(base)) return {additions: 0, deletions: 0};
        const result = await this.git(worktree, ['diff', '--numstat', ...DIFF_FLAGS, `${base}...${branch}`, '--']);
        return sumNumstat(result.code === 0 ? result.stdout : '');
    }

    public async status(worktree: string): Promise<FileChange[]> {
        const result = await this.git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        return result.code === 0 ? parseStatus(result.stdout) : [];
    }

    public workingDiff(worktree: string): Promise<string> {
        return this.working(worktree, []);
    }

    public async workingLineStats(worktree: string): Promise<LineStats> {
        return sumNumstat(await this.working(worktree, ['--numstat']));
    }

    /** `git diff` of the uncommitted changes in `format`, with untracked files as new ones. */
    private async working(worktree: string, format: readonly string[]): Promise<string> {
        const head = await this.git(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD']);
        const base = head.code === 0 ? 'HEAD' : EMPTY_TREE;
        const tracked = await this.git(worktree, ['diff', ...format, ...DIFF_FLAGS, base, '--']);
        let diff = tracked.code === 0 ? tracked.stdout : '';

        // Untracked files are not in any diff git keeps, and adding them with
        // `--intent-to-add` would write the index. Diffing each against
        // /dev/null reads the same as a new file, without touching anything.
        const others = await this.git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
        const untracked = others.code === 0 ? others.stdout.split('\0').filter(isUntrackedFile) : [];
        for (const file of untracked) {
            // `--no-index` exits 1 when the files differ, which here they always do.
            const added = await this.git(worktree, [
                'diff',
                '--no-index',
                ...format,
                ...DIFF_FLAGS,
                '--',
                '/dev/null',
                file,
            ]);
            if (added.code === 0 || added.code === 1) diff += added.stdout;
        }
        return diff;
    }

    public async mergeBase(worktree: string, branch: string, base: string): Promise<string | null> {
        if (!isSafeRef(branch) || !isSafeRef(base)) return null;
        const result = await this.git(worktree, ['merge-base', base, branch]);
        return result.code === 0 ? result.stdout.trim() || null : null;
    }

    public async blobSizes(worktree: string, revision: string, paths: readonly string[]): Promise<Map<string, number>> {
        const sizes = new Map<string, number>();
        // One object name per line: a path with a newline in it cannot be asked.
        const asked = paths.filter((file) => file.length > 0 && !file.includes('\n'));
        if (!isSafeRef(revision) || asked.length === 0) return sizes;
        const input = asked.map((file) => `${revision}:${file}\n`).join('');
        const result = await this.git(worktree, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], input);
        if (result.code !== 0) return sizes;
        // One answer line per question, in order; a missing one reads `<name> missing`.
        const lines = result.stdout.split('\n');
        asked.forEach((file, i) => {
            const match = /^blob (\d+)$/.exec(lines[i] ?? '');
            if (match) sizes.set(file, Number(match[1]));
        });
        return sizes;
    }

    public async blob(worktree: string, revision: string, file: string): Promise<Uint8Array | null> {
        if (!isSafeRef(revision) || file.length === 0) return null;
        // `cat-file blob` rather than `git show`: no textconv or other filter
        // stands between the bytes in the repository and the ones sent on.
        return this.gitBytes(worktree, ['cat-file', 'blob', `${revision}:${file}`]);
    }

    public workingFileSizes(worktree: string, paths: readonly string[]): Promise<Map<string, number>> {
        return this.runner.workingFileSizes(worktree, paths);
    }

    public workingFile(worktree: string, file: string): Promise<Uint8Array | null> {
        return this.runner.workingFile(worktree, file, MAX_OUTPUT_BYTES);
    }

    public async generatedPaths(worktree: string, paths: readonly string[]): Promise<string[]> {
        const generated: string[] = [];
        for (let i = 0; i < paths.length; i += CHECK_ATTR_CHUNK) {
            const chunk = paths.slice(i, i + CHECK_ATTR_CHUNK);
            const result = await this.git(worktree, ['check-attr', '-z', 'linguist-generated', '--', ...chunk]);
            if (result.code !== 0) continue;
            // `-z` output is `path NUL attribute NUL value NUL`, repeated.
            const fields = result.stdout.split('\0');
            for (let j = 0; j + 2 < fields.length; j += 3) {
                const value = fields[j + 2];
                if (value === 'set' || value === 'true') generated.push(fields[j]);
            }
        }
        return generated;
    }

    public async worktrees(repository: string): Promise<WorktreeSummary[]> {
        const list = await this.git(repository, ['worktree', 'list', '--porcelain', '-z']);
        if (list.code !== 0) return [];
        // Named before anything else reads them, so `status` and `log` below take
        // the same names the summaries hand back.
        const entries = parseWorktreeList(list.stdout)
            .filter((entry) => !entry.bare && !entry.prunable)
            .map((entry) => ({...entry, path: this.runner.fromHost(entry.path)}));
        if (entries.length === 0) return [];

        // A merged PR lands on origin's default branch; the local one may lag.
        const defaultBranch = await this.defaultBranch(repository);
        const remote = 'origin/' + defaultBranch;
        const base = (await this.commitSha(repository, remote))
            ? remote
            : (await this.commitSha(repository, defaultBranch))
              ? defaultBranch
              : null;

        return Promise.all(
            entries.map(async (entry): Promise<WorktreeSummary> => {
                const tip = entry.branch ?? entry.head;
                const {ahead} = base && tip ? await this.aheadBehind(repository, tip, base) : {ahead: 0};
                const changes = await this.status(entry.path);
                const last = await this.git(entry.path, ['log', '-1', '--format=%ct', 'HEAD']);
                const seconds = last.code === 0 ? Number(last.stdout.trim()) : NaN;
                return {
                    path: entry.path,
                    branch: entry.branch,
                    main: entry.main,
                    locked: entry.locked,
                    changedFiles: changes.length,
                    ahead,
                    merged: base !== null && entry.branch !== null && entry.branch !== defaultBranch && ahead === 0,
                    lastCommitAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
                };
            }),
        );
    }

    public watch(worktree: string, onChange: () => void): Disposable {
        return this.runner.watch(worktree, onChange);
    }

    // ── GitWorktrees: the worktree a session on a plan's issue starts in (A2), and its removal on archive ──

    public async mainCheckout(cwd: string): Promise<string | null> {
        const result = await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const common = result.code === 0 ? result.stdout.trim() : '';
        if (!common) return null;
        // The common dir is the main checkout's `.git`; anything else (a bare
        // repository, a submodule's dir under `.git/modules`) has no checkout above it.
        if (path.basename(common) === '.git') return this.runner.fromHost(path.dirname(common));
        return this.worktreeRoot(cwd);
    }

    public async fetchBranch(repository: string, branch: string): Promise<GitWrite> {
        if (!isSafeRef(branch)) return {ok: false, reason: 'Not a branch name: ' + branch};
        return this.gitWrite(
            repository,
            ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
            FETCH_TIMEOUT_MS,
        );
    }

    public async addWorktree(repository: string, worktree: string, branch: string, base: string): Promise<GitWrite> {
        if (!isSafeRef(branch) || !isSafeRef(base)) return {ok: false, reason: 'Not a branch name: ' + branch};
        const target = this.hostPath(worktree);
        if (target === null) return notHere(worktree);
        // The checkout runs LFS's smudge filter, which may download: give it the fetch's time.
        return this.gitWrite(
            repository,
            ['worktree', 'add', '--quiet', '--no-track', '-b', branch, target, base],
            FETCH_TIMEOUT_MS,
        );
    }

    public async checkoutWorktree(repository: string, worktree: string, branch: string): Promise<GitWrite> {
        if (!isSafeRef(branch)) return {ok: false, reason: 'Not a branch name: ' + branch};
        const target = this.hostPath(worktree);
        if (target === null) return notHere(worktree);
        return this.gitWrite(repository, ['worktree', 'add', '--quiet', target, branch], FETCH_TIMEOUT_MS);
    }

    public async removeWorktree(
        repository: string,
        worktree: string,
        {force = false}: {force?: boolean} = {},
    ): Promise<GitWrite> {
        const target = this.hostPath(worktree);
        if (target === null) return notHere(worktree);
        // Twice: once for changes, once more for a locked worktree.
        const args = force ? ['worktree', 'remove', '-f', '-f', target] : ['worktree', 'remove', target];
        return this.gitWrite(repository, args, REMOVE_TIMEOUT_MS);
    }

    public async pruneWorktrees(repository: string): Promise<GitWrite> {
        return this.gitWrite(repository, ['worktree', 'prune'], REMOVE_TIMEOUT_MS);
    }

    public async deleteBranch(repository: string, branch: string): Promise<GitWrite> {
        if (!isSafeRef(branch)) return {ok: false, reason: 'Not a branch name: ' + branch};
        return this.gitWrite(repository, ['branch', '-D', branch], REMOVE_TIMEOUT_MS);
    }
}

/** How long a fetch may take: it goes over the network. */
const FETCH_TIMEOUT_MS = 60_000;

/** How long removing a worktree may take: a large `node_modules` is slow to delete. */
const REMOVE_TIMEOUT_MS = 60_000;

/** A worktree path on another machine than the repository it was asked of. */
function notHere(worktree: string): GitWrite {
    return {ok: false, reason: 'Not on the same machine as the repository: ' + worktree};
}

/**
 * The lines added and removed in `git diff --numstat` output. A binary file
 * counts `-` for both, which adds nothing.
 */
export function sumNumstat(output: string): LineStats {
    let additions = 0;
    let deletions = 0;
    for (const line of output.split('\n')) {
        const [added, removed] = line.split('\t');
        if (removed === undefined) continue;
        additions += Number(added) || 0;
        deletions += Number(removed) || 0;
    }
    return {additions, deletions};
}

/**
 * An untracked entry that is a file. git lists a nested repository it will not
 * descend into as its directory, with a trailing `/`.
 */
function isUntrackedFile(entry: string): boolean {
    return entry.length > 0 && !entry.endsWith('/');
}

/** One record of `git worktree list --porcelain`. */
export interface WorktreeListEntry {
    path: string;
    /** The commit checked out; null in a bare repository. */
    head: string | null;
    /** The branch checked out, without `refs/heads/`; null on a detached HEAD or in a bare repository. */
    branch: string | null;
    /** The first record: the main checkout, or the bare repository the others were added from. */
    main: boolean;
    bare: boolean;
    detached: boolean;
    locked: boolean;
    /** Its directory has gone; `git worktree prune` would drop it. */
    prunable: boolean;
}

/**
 * `git worktree list --porcelain -z` as records.
 *
 * Each attribute is its own NUL-terminated field, `label` or `label value`,
 * and an empty field ends a record. `locked` and `prunable` may carry a
 * reason after the label, which is not kept.
 */
export function parseWorktreeList(output: string): WorktreeListEntry[] {
    const entries: WorktreeListEntry[] = [];
    let entry: WorktreeListEntry | null = null;
    for (const field of output.split('\0')) {
        if (field === '') {
            entry = null;
            continue;
        }
        const space = field.indexOf(' ');
        const label = space === -1 ? field : field.slice(0, space);
        const value = space === -1 ? '' : field.slice(space + 1);
        if (label === 'worktree') {
            entry = {
                path: value,
                head: null,
                branch: null,
                main: entries.length === 0,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
            };
            entries.push(entry);
            continue;
        }
        if (!entry) continue;
        if (label === 'HEAD') entry.head = value || null;
        else if (label === 'branch') entry.branch = value.replace(/^refs\/heads\//, '') || null;
        else if (label === 'bare') entry.bare = true;
        else if (label === 'detached') entry.detached = true;
        else if (label === 'locked') entry.locked = true;
        else if (label === 'prunable') entry.prunable = true;
    }
    return entries;
}

/**
 * `git status --porcelain=v1 -z` as file changes.
 *
 * Each entry is `XY path`, and a rename or copy is followed by its old path as
 * the next NUL-separated field. X is the index, Y the worktree; a file staged
 * as new and then edited is still a new file, so the index side wins where
 * they disagree, except that a deletion on either side is a deletion. A nested
 * repository (an untracked entry ending in `/`) is left out.
 */
export function parseStatus(output: string): FileChange[] {
    const fields = output.split('\0');
    const changes: FileChange[] = [];
    for (let i = 0; i < fields.length; i++) {
        const entry = fields[i];
        if (entry.length < 4) continue;
        const x = entry[0];
        const y = entry[1];
        const filePath = entry.slice(3);
        if (x === '!' && y === '!') continue;

        let status: FileStatus;
        if (x === '?' && y === '?') {
            // A nested repository — an agent's worktree under `.claude/worktrees/`,
            // a clone inside the checkout — is listed as one entry ending in `/`.
            // It is another repository's business and has no diff here.
            if (!isUntrackedFile(filePath)) continue;
            status = 'untracked';
        } else if (x === 'R' || y === 'R') status = 'renamed';
        else if (x === 'C' || y === 'C') status = 'copied';
        else if (x === 'D' || y === 'D') status = 'deleted';
        else if (x === 'A') status = 'added';
        else status = 'modified';

        const change: FileChange = {path: filePath, status};
        if (status === 'renamed' || status === 'copied') {
            change.oldPath = fields[++i];
        }
        changes.push(change);
    }
    return changes;
}
