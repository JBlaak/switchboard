/**
 * The VM's project copies (#276 stage 2, #286): chunked uploads, making or
 * updating a copy, where a copy stands, pushing its branch and removing it.
 *
 * A project hand-off makes a real repository on the VM, cloned from origin
 * with the VM's own credentials (`gh repo clone` uses the VM's gh login and
 * its protocol), so the copy can push and open pull requests by itself. The
 * Mac's own state comes across on top of that clone: the commits origin lacks
 * as a git bundle, the uncommitted changes as a binary patch, and the ignored
 * config files the user ticked, inline.
 *
 * The agent only ever deletes, or overwrites the branch of, a copy it made
 * itself. Every copy gets COPY_MARKER in its `.git`; a folder at the copy's
 * place without one is someone else's and is refused, never touched. A copy
 * with uncommitted changes of its own is refused too, naming the files: a
 * re-hand-off must never discard work done on the VM.
 *
 * A copy left dirty by the previous hand-off alone (its patch) is not work of
 * the VM's: the marker records what that hand-off left, and the next one
 * discards exactly that and nothing else.
 *
 * Everything a copy does runs through two small ports below (commands and
 * files) with Node adapters in `src/infrastructure/agent/`, and operations on
 * one copy's folder run one at a time, so a status read or a removal can never
 * land in the middle of a hand-off into the same folder.
 */
import {COPY_MARKER, HANDOFF_FILES_CAP_BYTES, isSafeRepoPath} from '../../../domain/agent/protocol';
import type {
    CopyCommit,
    CopyStatusMessage,
    HandoffDoneMessage,
    HandoffMessage,
    HostSettings,
    PushBranchMessage,
    RemoveCopyMessage,
} from '../../../domain/agent/protocol';
import type {ClientLink} from '../../ports/agent-link';
import type {Clock, Timers} from '../../ports/clock';
import type {IdGenerator} from '../../ports/ids';
import type {Logger} from '../../ports/logger';
import {Uploads} from './copies-uploads';
import type {CommandResult} from './host-config';
import type {CopiesMessage, CopiesPart} from './handlers';
import {expandHome} from './session-host';

// ── Ports ──

/**
 * Runs git and gh without a shell, with no stdin, in a folder. Like the host
 * config's CommandRunner, it never rejects: a missing binary or a timeout is
 * an `exitCode` of null.
 */
export interface CopyCommandRunner {
    run(
        command: string,
        args: string[],
        options: {cwd?: string; env?: Record<string, string>; timeoutMs: number},
    ): Promise<CommandResult>;
}

/** The file work a copy needs, on absolute paths. */
export interface CopiesFiles {
    /** Make a new folder only this user can read (0700) under the temp folder; its absolute path. */
    makePrivateTempDir(): string;
    /** Append to a file, creating it (0600) when missing; may throw. */
    append(path: string, bytes: Uint8Array): void;
    /** The file's hex SHA-256. */
    sha256(path: string): Promise<string>;
    /** Write a file so no reader sees half of it (temp file, then rename), creating its folders; may throw. */
    writeFileAtomic(path: string, bytes: Uint8Array, mode: number): void;
    /**
     * Write `relative` under `root` atomically, refusing (throwing) when the
     * folder it lands in resolves outside `root`, as through a symlink the
     * repository holds. The second lock after `isSafeRepoPath`.
     */
    writeInside(root: string, relative: string, bytes: Uint8Array, mode: number): void;
    /** `rm -rf`; a missing path is fine; may throw. */
    removeTree(path: string): void;
    exists(path: string): boolean;
    /** The file's text, or null when it cannot be read. */
    readText(path: string): string | null;
    /** Copy a file over another; may throw. */
    copyFile(from: string, to: string): void;
    /** The path with every symlink resolved, or null when it does not exist. */
    realpath(path: string): string | null;
}

// ── Limits ──

/** How long a clone, fetch or push may take. A big repository over a slow link takes a while. */
export const NETWORK_TIMEOUT_MS = 30 * 60 * 1000;

/** How long a local git command may take (status, checkout, apply). */
export const LOCAL_TIMEOUT_MS = 2 * 60 * 1000;

/** How many unpushed commits `copy-status` lists; the Mac shows a list, not a log. */
export const MAX_UNPUSHED_LISTED = 50;

/** How much of git's stderr goes into an error: its tail, where git puts the reason. */
const MAX_ERROR_CHARS = 1200;

/** Only these bits of a file's mode are kept: never setuid, setgid or sticky. */
const MODE_MASK = 0o777;

/**
 * Where a session's worktree lives inside a copy, as `claude --worktree`
 * makes them on the Mac, so the session's paths still make sense on the VM.
 */
export const WORKTREES_FOLDER = '.claude/worktrees';

/** Where a bundle's refs are fetched to, out of the way of branches and tags. */
const HANDOFF_REFS = 'refs/switchboard/handoff/';

/**
 * Every git and gh command gets these, so nothing ever waits on a prompt the
 * Mac can't see: the agent runs headless, and a hang there is a hand-off that
 * never answers.
 */
const NO_PROMPTS: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
};

export interface CopiesDeps {
    commands: CopyCommandRunner;
    files: CopiesFiles;
    /** The host's settings now, for the base folder. */
    hostSettings: () => HostSettings;
    /** The VM user's home folder, for `~`. */
    home: string;
    clock: Clock;
    timers: Timers;
    ids: IdGenerator;
    log: Logger;
    /** Overrides MAX_UPLOAD_BYTES, for tests. */
    maxUploadBytes?: number;
}

/**
 * A checkout a hand-off lands in: the copy's main folder, or one of its
 * worktrees. `gitDir` is where its index and its record (the marker) live:
 * `<copy>/.git` for the main folder, `<copy>/.git/worktrees/<n>` for a
 * worktree, so each checkout has its own record and the main folder's is
 * never rewritten by a worktree hand-off.
 */
interface Checkout {
    abs: string;
    gitDir: string;
}

/** A failed step: what the progress called it, and what went wrong. */
class StepFailed extends Error {
    constructor(
        public readonly step: string,
        public readonly detail: string,
    ) {
        super(`${step} failed: ${detail}`);
    }
}

export class Copies implements CopiesPart {
    private readonly uploads: Uploads;
    /** The tail of each folder's queue of operations, keyed by its absolute path. */
    private readonly locks = new Map<string, Promise<void>>();

    constructor(private readonly deps: CopiesDeps) {
        this.uploads = new Uploads({
            files: deps.files,
            timers: deps.timers,
            ids: deps.ids,
            log: deps.log,
            maxBytes: deps.maxUploadBytes,
        });
    }

    public clientConnected(_client: ClientLink): void {}

    /** Its unfinished uploads go; hand-offs it started run on, as they change only the VM. */
    public clientGone(client: ClientLink): void {
        this.uploads.clientGone(client);
    }

    public handle(client: ClientLink, message: CopiesMessage): void {
        switch (message.type) {
            case 'upload-begin':
                return this.uploads.begin(client, message);
            case 'upload-chunk':
                return this.uploads.chunk(message);
            case 'upload-end':
                void this.uploads.end(client, message);
                return;
            case 'handoff':
                void this.handoff(client, message);
                return;
            case 'copy-status':
                void this.copyStatus(client, message);
                return;
            case 'push-branch':
                void this.pushBranch(client, message);
                return;
            case 'remove-copy':
                void this.removeCopy(client, message);
                return;
        }
    }

    /** How many uploads are held, for tests. */
    public get uploadCount(): number {
        return this.uploads.count;
    }

    // ── handoff ──

    private async handoff(client: ClientLink, message: HandoffMessage): Promise<void> {
        const {requestId} = message;
        const answer = (done: Omit<HandoffDoneMessage, 'type' | 'requestId'>) => {
            if (!client.closed) client.send({type: 'handoff-done', requestId, ...done});
        };
        const progress = (line: string) => {
            if (!client.closed) client.send({type: 'handoff-progress', requestId, line});
        };
        const usedUploads = [message.bundleUploadId, message.patchUploadId].filter((id): id is string => !!id);

        try {
            const refused = refuseHandoff(message);
            if (refused) return answer({ok: false, error: refused});

            const dir = joinDir(this.deps.hostSettings().baseFolder, message.repo.name);
            const abs = expandHome(dir, this.deps.home);
            // A worktree hand-off answers with the worktree, the folder its session resumes in.
            const answerDir =
                message.worktree === undefined ? dir : joinDir(joinDir(dir, WORKTREES_FOLDER), message.worktree);
            const bundle = message.bundleUploadId ? this.uploads.fileOf(message.bundleUploadId) : null;
            if (bundle && 'error' in bundle) return answer({ok: false, error: bundle.error});
            const patch = message.patchUploadId ? this.uploads.fileOf(message.patchUploadId) : null;
            if (patch && 'error' in patch) return answer({ok: false, error: patch.error});

            await this.exclusive(abs, async () => {
                try {
                    const reused = await this.makeCopy(message, dir, abs, progress, {
                        bundle: bundle?.file ?? null,
                        patch: patch && patch.size > 0 ? patch.file : null,
                    });
                    progress('Done');
                    answer({ok: true, dir: answerDir, reused});
                } catch (err) {
                    const error = err instanceof StepFailed ? err.message : `hand-off failed: ${errorText(err)}`;
                    this.deps.log.warn(`[copies] hand-off into ${abs}: ${error}`);
                    answer({ok: false, error});
                }
            });
        } finally {
            for (const id of usedUploads) this.uploads.drop(id);
        }
    }

    /**
     * The hand-off's steps, in order; true when an existing checkout (the
     * copy's main folder, or the worktree for a worktree hand-off) was updated
     * rather than made. Throws StepFailed.
     *
     * A worktree hand-off (`message.worktree`) clones or fetches the copy as
     * usual but leaves its main folder's checkout alone: the session's work
     * lands in `<copy>/.claude/worktrees/<name>` instead, with its own record,
     * so a project hand-off and a session's worktree hand-off into the same
     * copy never discard each other's changes.
     */
    private async makeCopy(
        message: HandoffMessage,
        dir: string,
        abs: string,
        progress: (line: string) => void,
        uploads: {bundle: string | null; patch: string | null},
    ): Promise<boolean> {
        const {repo, branch, headOid, worktree} = message;
        const copyReused = await this.cloneOrFetch(message, dir, abs, progress, worktree === undefined);
        const fetched = await this.fetchBundle(abs, uploads.bundle, progress);

        const checkoutStep =
            worktree === undefined ? `Checking out ${branch}` : `Checking out ${branch} in ${worktree}`;
        progress(checkoutStep);
        const hasHead = await this.git(abs, ['cat-file', '-e', `${headOid}^{commit}`]);
        if (hasHead.exitCode !== 0) {
            throw new StepFailed(
                checkoutStep,
                `commit ${headOid.slice(0, 12)} is not on origin or in the bundle; push it, or hand off again`,
            );
        }

        let target: Checkout;
        let reused: boolean;
        if (worktree === undefined) {
            target = {abs, gitDir: `${abs.replace(/\/+$/, '')}/.git`};
            reused = copyReused;
            if (reused) await this.refuseLosingCommits(checkoutStep, abs, branch, headOid);
            await this.must(checkoutStep, abs, ['checkout', '--no-track', '-B', branch, headOid]);
        } else {
            ({target, reused} = await this.checkOutWorktree(checkoutStep, message, dir, abs, worktree));
        }
        for (const ref of fetched) await this.git(abs, ['update-ref', '-d', ref]);
        const remoteBranch = `refs/remotes/origin/${branch}`;
        if ((await this.git(abs, ['rev-parse', '--verify', '--quiet', remoteBranch])).exitCode === 0) {
            await this.must(checkoutStep, abs, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
        }

        if (uploads.patch) {
            const step = 'Applying your uncommitted changes';
            progress(step);
            // Working tree only, unstaged, as it was on the Mac before the
            // hand-off took its snapshot.
            await this.must(step, target.abs, ['apply', '--binary', '--whitespace=nowarn', uploads.patch]);
        }

        if (message.files.length) {
            const step = `Writing ${message.files.length} ${message.files.length === 1 ? 'file' : 'files'}`;
            progress(step);
            for (const file of message.files) {
                try {
                    this.deps.files.writeInside(
                        target.abs,
                        file.path,
                        Buffer.from(file.contentBase64, 'base64'),
                        file.mode & MODE_MASK || 0o644,
                    );
                } catch (err) {
                    throw new StepFailed(step, `${file.path}: ${errorText(err)}`);
                }
            }
        }

        const recordStep = 'Recording the copy';
        const state = await this.copyState(
            recordStep,
            target,
            message.files.map((file) => file.path),
        );
        this.writeMarker(recordStep, markerIn(target.gitDir), repo.origin, state);
        return reused;
    }

    /**
     * Make the copy's repository at `abs`, or bring an existing one up to date
     * with origin; true when it existed. A folder there without the marker is
     * someone else's and refused. `clearMain` says whether the main folder's
     * own leftovers are checked and cleared: only a hand-off onto the main
     * folder does that, as a worktree hand-off never changes its checkout.
     */
    private async cloneOrFetch(
        message: HandoffMessage,
        dir: string,
        abs: string,
        progress: (line: string) => void,
        clearMain: boolean,
    ): Promise<boolean> {
        const {repo} = message;
        if (this.deps.files.exists(abs)) {
            const step = `Checking the copy at ${dir}`;
            progress(step);
            if (!this.deps.files.exists(markerPath(abs))) {
                throw new StepFailed(
                    step,
                    `${dir} already exists and is not a copy Switchboard made; move it away or change the base folder`,
                );
            }
            if (clearMain) await this.clearOwnChanges(step, {abs, gitDir: `${abs.replace(/\/+$/, '')}/.git`});
            const fetchStep = 'Fetching origin';
            progress(fetchStep);
            await this.must(fetchStep, abs, ['fetch', '--prune', 'origin'], NETWORK_TIMEOUT_MS);
            return true;
        }
        const step = repo.github ? `Cloning ${repo.github} into ${dir}` : `Cloning ${repo.origin} into ${dir}`;
        progress(step);
        // gh clones with the VM's own login and preferred protocol; a
        // repository not on GitHub falls back to plain git and whatever
        // credentials the VM has for its host.
        if (repo.github) await this.run(step, 'gh', ['repo', 'clone', repo.github, abs], undefined, NETWORK_TIMEOUT_MS);
        else await this.must(step, undefined, ['clone', '--', repo.origin, abs], NETWORK_TIMEOUT_MS);
        // Marked straight away, so a hand-off that fails further on still
        // leaves a copy the next one may reuse and Remove may delete.
        this.writeMarker(step, markerPath(abs), repo.origin);
        return false;
    }

    /**
     * Fetch the bundle's refs into the copy's repository, under HANDOFF_REFS;
     * the refs fetched, for the caller to delete once the checkout has them.
     * One repository serves the main folder and every worktree, so this is the
     * same for both kinds of hand-off.
     */
    private async fetchBundle(abs: string, bundle: string | null, progress: (line: string) => void): Promise<string[]> {
        if (!bundle) return [];
        const step = 'Fetching your unpushed commits';
        progress(step);
        await this.must(step, abs, ['bundle', 'verify', bundle]);
        const heads = parseBundleHeads(await this.must(step, abs, ['bundle', 'list-heads', bundle]));
        if (!heads.length) throw new StepFailed(step, 'the bundle holds no refs');
        const refspecs = heads.map((ref) => `+${ref}:${handoffRef(ref)}`);
        await this.must(step, abs, ['fetch', '--no-tags', bundle, ...refspecs]);
        return heads.map(handoffRef);
    }

    /**
     * Put the worktree `<copy>/.claude/worktrees/<name>` on `branch` at
     * `headOid`, making it when missing; the checkout to patch and record, and
     * whether the worktree existed.
     *
     * A worktree that exists gets the same rules as a re-hand-off onto the
     * main folder, inside it: its own record (in its own git dir) decides
     * which changes are this agent's leftovers to discard, and commits only
     * the VM has on the branch are never moved off. A folder at that place
     * that is not one of this copy's worktrees is someone else's and refused.
     *
     * Git lets a branch be checked out in only one worktree, and `-B` on a
     * branch checked out elsewhere would fail with git's own words, or worse,
     * be the main folder's branch the user is working on; it is refused up
     * front, naming where it is checked out.
     */
    private async checkOutWorktree(
        step: string,
        message: HandoffMessage,
        dir: string,
        abs: string,
        name: string,
    ): Promise<{target: Checkout; reused: boolean}> {
        const {files} = this.deps;
        const {branch, headOid} = message;
        const copyRoot = abs.replace(/\/+$/, '');
        const wtAbs = `${copyRoot}/${WORKTREES_FOLDER}/${name}`;
        const wtDir = `${dir.replace(/\/+$/, '')}/${WORKTREES_FOLDER}/${name}`;
        const copyReal = files.realpath(copyRoot) ?? copyRoot;

        // The worktrees folder comes from the repository's own tree when it
        // tracks `.claude/`; a symlink there must not put a worktree, and the
        // patch and files with it, outside the copy.
        for (const folder of [`${copyRoot}/.claude`, `${copyRoot}/${WORKTREES_FOLDER}`, wtAbs]) {
            const real = files.realpath(folder);
            if (real !== null && real !== `${copyReal}${folder.slice(copyRoot.length)}`) {
                throw new StepFailed(step, `${folder.slice(copyRoot.length + 1)} in the copy is a symlink`);
            }
        }

        // A worktree deleted by hand stays registered until pruned, and then
        // blocks `worktree add` at its path.
        await this.must(step, abs, ['worktree', 'prune']);
        const worktrees = parseWorktreeList(await this.must(step, abs, ['worktree', 'list', '--porcelain']));
        const realOf = (path: string) => files.realpath(path) ?? path.replace(/\/+$/, '');
        const wtReal = realOf(wtAbs);
        const elsewhere = worktrees.find((entry) => entry.branch === branch && realOf(entry.path) !== wtReal);
        if (elsewhere) {
            const where = realOf(elsewhere.path);
            const named =
                where === copyReal
                    ? `the copy's main folder ${dir}`
                    : where.startsWith(copyReal + '/')
                      ? `${dir.replace(/\/+$/, '')}${where.slice(copyReal.length)}`
                      : where;
            throw new StepFailed(
                step,
                `${branch} is checked out in ${named}; switch that one to another branch first, or hand off from another branch`,
            );
        }

        const reused = files.exists(wtAbs);
        if (reused) {
            const own = worktrees.some((entry) => entry.path !== worktrees[0]?.path && realOf(entry.path) === wtReal);
            if (!own) {
                throw new StepFailed(
                    step,
                    `${wtDir} already exists and is not a worktree of the copy; move it away on the VM first`,
                );
            }
            const target = {abs: wtAbs, gitDir: await this.gitDirOf(step, wtAbs)};
            await this.clearOwnChanges(`Checking the worktree at ${wtDir}`, target);
            await this.refuseLosingCommits(step, abs, branch, headOid);
            await this.must(step, wtAbs, ['checkout', '--no-track', '-B', branch, headOid]);
            return {target, reused};
        }

        await this.refuseLosingCommits(step, abs, branch, headOid);
        this.excludeWorktrees(step, copyRoot);
        await this.must(step, abs, ['worktree', 'add', '--quiet', '--no-track', '-B', branch, wtAbs, headOid]);
        const target = {abs: wtAbs, gitDir: await this.gitDirOf(step, wtAbs)};
        // Marked straight away, as a fresh clone is, so a hand-off that fails
        // further on leaves a worktree the next one may reuse.
        this.writeMarker(step, markerIn(target.gitDir), message.repo.origin);
        return {target, reused};
    }

    /** A worktree's own git dir, `<copy>/.git/worktrees/<n>`: where its index and record live. */
    private async gitDirOf(step: string, wtAbs: string): Promise<string> {
        return (await this.must(step, wtAbs, ['rev-parse', '--absolute-git-dir'])).trim();
    }

    /**
     * Keep the worktrees folder out of the main folder's status. It sits
     * inside the main checkout, so without this every worktree would show
     * there as an untracked `.claude/`, the main folder's next hand-off would
     * read that as work of the VM's and refuse, and `copy-status` would list
     * it as uncommitted. `.git/info/exclude` is the copy's own, never pushed.
     */
    private excludeWorktrees(step: string, copyRoot: string): void {
        const exclude = `${copyRoot}/.git/info/exclude`;
        const line = `/${WORKTREES_FOLDER}/`;
        const text = this.deps.files.readText(exclude) ?? '';
        if (text.split('\n').some((existing) => existing.trim() === line)) return;
        const next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
        try {
            this.deps.files.writeFileAtomic(exclude, Buffer.from(next, 'utf8'), 0o644);
        } catch (err) {
            throw new StepFailed(step, `could not exclude ${WORKTREES_FOLDER} from the copy: ${errorText(err)}`);
        }
    }

    /**
     * Make a reused copy clean, or refuse. A copy left dirty by the previous
     * hand-off itself (its patch, its ticked files) is the usual case, and its
     * changes are the Mac's, which this hand-off brings again: when HEAD, the
     * working tree and the ticked files are exactly as that hand-off recorded
     * them, nobody worked in the copy since, and they are discarded. Anything
     * else is work done on the VM, which is never discarded: refused, naming
     * what changed.
     */
    private async clearOwnChanges(step: string, target: Checkout): Promise<void> {
        const {abs} = target;
        const recorded = parseMarkerState(this.deps.files.readText(markerIn(target.gitDir)));
        const refuse = (changed: string[]) =>
            new StepFailed(
                step,
                `the copy has uncommitted changes of its own: ${listed(changed)}. ` +
                    'Commit, push or discard them on the VM first',
            );

        if (recorded && recorded.files.length) {
            const now = await this.blobHashes(
                abs,
                recorded.files.map((file) => file.path),
            );
            const changed = recorded.files.filter((file) => now.get(file.path) !== file.blob).map((file) => file.path);
            if (changed.length) throw refuse(changed);
        }

        const dirty = parsePorcelainZ(await this.must(step, abs, ['status', '--porcelain=v1', '-z']));
        if (!dirty.length) return;
        if (!recorded) throw refuse(dirty);
        const head = (await this.must(step, abs, ['rev-parse', 'HEAD'])).trim();
        const tree = await this.workingTree(step, target);
        if (head !== recorded.head) throw refuse(dirty);
        if (tree !== recorded.tree) {
            // Name only what changed since the hand-off, not what it brought.
            const diff = await this.git(abs, ['diff', '--name-only', '-z', recorded.tree, tree]);
            const changed = diff.exitCode === 0 ? diff.stdout.split('\0').filter(Boolean) : [];
            throw refuse(changed.length ? changed : dirty);
        }
        // Untracked files the patch made go with `clean -fd`; never `-x`,
        // which would take the ignored ticked files and the VM's own build
        // output and dependencies with it.
        await this.must(step, abs, ['reset', '--hard', '--quiet']);
        await this.must(step, abs, ['clean', '-fd', '--quiet']);
    }

    /** HEAD, the working tree and the ticked files' blobs, as the marker records them. */
    private async copyState(step: string, target: Checkout, files: string[]): Promise<CopyRecord> {
        const {abs} = target;
        const head = (await this.must(step, abs, ['rev-parse', 'HEAD'])).trim();
        const tree = await this.workingTree(step, target);
        const blobs = await this.blobHashes(abs, files);
        return {
            head,
            tree,
            files: files.flatMap((path) => (blobs.has(path) ? [{path, blob: blobs.get(path) as string}] : [])),
        };
    }

    /**
     * The tree the working tree would commit as, untracked files included and
     * ignored ones not, without touching the real index: a copy of it (so
     * unchanged files are not hashed again) in a temp index, `add -A`, then
     * `write-tree`. A worktree's index is in its own git dir, so the copy of
     * it goes there too.
     */
    private async workingTree(step: string, target: Checkout): Promise<string> {
        const {abs} = target;
        const gitDir = target.gitDir.replace(/\/+$/, '');
        const index = `${gitDir}/switchboard-${this.deps.ids.newId()}.index`;
        try {
            if (this.deps.files.exists(`${gitDir}/index`)) this.deps.files.copyFile(`${gitDir}/index`, index);
            const env = {GIT_INDEX_FILE: index};
            await this.must(step, abs, ['add', '-A'], LOCAL_TIMEOUT_MS, env);
            return (await this.must(step, abs, ['write-tree'], LOCAL_TIMEOUT_MS, env)).trim();
        } catch (err) {
            if (err instanceof StepFailed) throw err;
            throw new StepFailed(step, `could not read the working tree: ${errorText(err)}`);
        } finally {
            try {
                this.deps.files.removeTree(index);
            } catch {
                // A stray temp index in .git harms nothing.
            }
        }
    }

    /** The git blob hash of each of `paths` that exists in the copy. */
    private async blobHashes(abs: string, paths: string[]): Promise<Map<string, string>> {
        const root = abs.replace(/\/+$/, '');
        const present = paths.filter((path) => isSafeRepoPath(path) && this.deps.files.exists(`${root}/${path}`));
        const hashes = new Map<string, string>();
        if (!present.length) return hashes;
        const result = await this.git(abs, ['hash-object', '--', ...present]);
        if (result.exitCode !== 0) return hashes;
        const lines = result.stdout.split('\n').filter(Boolean);
        present.forEach((path, i) => {
            if (lines[i]) hashes.set(path, lines[i].trim());
        });
        return hashes;
    }

    /**
     * Refuse to move a copy's branch off commits that exist only there: work
     * the VM committed and never pushed would otherwise be left behind by
     * `checkout -B`, findable only in the reflog.
     */
    private async refuseLosingCommits(step: string, abs: string, branch: string, headOid: string): Promise<void> {
        const local = `refs/heads/${branch}`;
        if ((await this.git(abs, ['rev-parse', '--verify', '--quiet', local])).exitCode !== 0) return;
        const only = await this.must(step, abs, [
            'log',
            '--format=%h %s',
            `-n`,
            '10',
            local,
            '--not',
            headOid,
            '--remotes=origin',
        ]);
        const commits = only.split('\n').filter(Boolean);
        if (commits.length) {
            throw new StepFailed(
                step,
                `the copy's ${branch} has commits that are neither on your Mac nor on origin: ${listed(commits)}. ` +
                    'Push them and bring them back first',
            );
        }
    }

    /** Write a marker file: the main folder's in `.git`, a worktree's in its own git dir. */
    private writeMarker(step: string, file: string, origin: string, state?: CopyRecord): void {
        const handedOffAt = new Date(this.deps.clock.now()).toISOString();
        const content = JSON.stringify(state ? {handedOffAt, origin, state} : {handedOffAt, origin}) + '\n';
        try {
            this.deps.files.writeFileAtomic(file, Buffer.from(content, 'utf8'), 0o644);
        } catch (err) {
            throw new StepFailed(step, `could not mark the copy: ${errorText(err)}`);
        }
    }

    // ── copy-status ──

    private async copyStatus(client: ClientLink, message: CopyStatusMessage): Promise<void> {
        const {requestId} = message;
        const abs = expandHome(message.dir, this.deps.home);
        await this.exclusive(abs, async () => {
            let state;
            try {
                state = await this.readState(abs);
            } catch (err) {
                const error = err instanceof StepFailed ? err.message : errorText(err);
                if (!client.closed) client.send({type: 'copy-state', requestId, ok: false, error});
                return;
            }
            if (!client.closed) client.send({type: 'copy-state', requestId, ok: true, ...state});
        });
    }

    private async readState(abs: string): Promise<{
        branch: string | null;
        headOid: string;
        upstream: string | null;
        unpushed: CopyCommit[];
        uncommitted: string[];
    }> {
        const step = `Reading ${abs}`;
        if (!this.deps.files.exists(abs)) throw new StepFailed(step, 'no such folder');
        const headOid = (await this.must(step, abs, ['rev-parse', 'HEAD'])).trim();
        const symbolic = await this.git(abs, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() || null : null;
        const up = await this.git(abs, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
        const upstream = up.exitCode === 0 ? up.stdout.trim() || null : null;
        const range = upstream ? [`${upstream}..HEAD`] : ['HEAD', '--not', '--remotes=origin'];
        const log = await this.must(step, abs, [
            'log',
            '--format=%H%x00%s',
            '-n',
            String(MAX_UNPUSHED_LISTED),
            ...range,
        ]);
        const uncommitted = parsePorcelainZ(await this.must(step, abs, ['status', '--porcelain=v1', '-z']));
        return {branch, headOid, upstream, unpushed: parseCommits(log), uncommitted};
    }

    // ── push-branch ──

    private async pushBranch(client: ClientLink, message: PushBranchMessage): Promise<void> {
        const {requestId, branch} = message;
        const answer = (error?: string) => {
            if (client.closed) return;
            client.send(error ? {type: 'done', requestId, ok: false, error} : {type: 'done', requestId, ok: true});
        };
        if (!isPlausibleBranch(branch)) return answer(`"${branch}" is not a branch name`);
        const abs = expandHome(message.dir, this.deps.home);
        await this.exclusive(abs, async () => {
            try {
                if (!this.deps.files.exists(abs))
                    throw new StepFailed(`Pushing ${branch}`, `${message.dir} does not exist`);
                await this.must(`Pushing ${branch}`, abs, ['push', '-u', 'origin', branch], NETWORK_TIMEOUT_MS);
                answer();
            } catch (err) {
                answer(err instanceof StepFailed ? err.message : errorText(err));
            }
        });
    }

    // ── remove-copy ──

    private async removeCopy(client: ClientLink, message: RemoveCopyMessage): Promise<void> {
        const {requestId} = message;
        const answer = (error?: string) => {
            if (client.closed) return;
            client.send(error ? {type: 'done', requestId, ok: false, error} : {type: 'done', requestId, ok: true});
        };
        const abs = expandHome(message.dir, this.deps.home);
        await this.exclusive(abs, async () => {
            const checked = this.checkRemoval(message.dir, abs);
            if (checked.error !== undefined) {
                this.deps.log.warn(`[copies] refused to remove ${message.dir}: ${checked.error}`);
                return answer(checked.error);
            }
            if (checked.copy !== undefined) {
                // Only this worktree goes, through git, so the copy's
                // worktree list forgets it too; `--force` because the Mac
                // has listed its uncommitted changes before asking.
                const step = `Removing ${message.dir}`;
                try {
                    await this.must(step, checked.copy, ['worktree', 'remove', '--force', checked.real]);
                    await this.git(checked.copy, ['worktree', 'prune']);
                    this.deps.log.info(`[copies] removed the worktree ${message.dir}`);
                    answer();
                } catch (err) {
                    answer(err instanceof StepFailed ? err.message : errorText(err));
                }
                return;
            }
            // A copy's worktrees live inside it, so they go with it; nothing
            // is left registered anywhere, as the repository goes too.
            try {
                this.deps.files.removeTree(checked.real);
                this.deps.log.info(`[copies] removed ${message.dir}`);
                answer();
            } catch (err) {
                answer(`could not remove ${message.dir}: ${errorText(err)}`);
            }
        });
    }

    /**
     * The folder to remove, symlinks resolved, or why it may not be removed:
     * it must resolve to a folder strictly inside the base folder (resolved
     * too) and hold the marker only a hand-off leaves. The resolved path is
     * the one removed, so a symlink can't point the removal anywhere else.
     *
     * A worktree of a copy, `<copy>/.claude/worktrees/<name>` resolved, has no
     * marker of its own in its folder (its `.git` is a file); it may be
     * removed when its copy holds the marker, and then `copy` names the copy
     * whose git removes it.
     */
    private checkRemoval(dir: string, abs: string): {real: string; copy?: string; error?: undefined} | {error: string} {
        const {files} = this.deps;
        const baseFolder = this.deps.hostSettings().baseFolder;
        const base = files.realpath(expandHome(baseFolder, this.deps.home));
        if (base === null) return {error: `the base folder ${baseFolder} does not exist`};
        const real = files.realpath(abs);
        if (real === null) return {error: `${dir} does not exist`};
        if (real === base || !real.startsWith(base.replace(/\/+$/, '') + '/')) {
            return {error: `${dir} is not inside the base folder ${baseFolder}`};
        }
        const worktree = /^(.+)\/\.claude\/worktrees\/([^/]+)$/.exec(real.slice(base.replace(/\/+$/, '').length));
        if (worktree && isSafeWorktreeName(worktree[2])) {
            const copy = base.replace(/\/+$/, '') + worktree[1];
            if (!files.exists(markerPath(copy))) return {error: `${dir} is not in a copy Switchboard made`};
            return {real, copy};
        }
        if (!files.exists(markerPath(real))) return {error: `${dir} is not a copy Switchboard made`};
        return {real};
    }

    // ── Running things ──

    /**
     * Run `work` once every earlier operation on the same folder is done, so
     * two hand-offs, or a hand-off and a removal, never interleave.
     */
    private async exclusive(abs: string, work: () => Promise<void>): Promise<void> {
        const key = lockKeyOf(abs);
        const before = this.locks.get(key) ?? Promise.resolve();
        const mine = before.then(work, work).catch((err: unknown) => {
            this.deps.log.error(`[copies] ${key}: ${errorText(err)}`);
        });
        this.locks.set(key, mine);
        await mine;
        if (this.locks.get(key) === mine) this.locks.delete(key);
    }

    /** A git command whose failure is only an answer, not an error. */
    private git(cwd: string, args: string[], timeoutMs = LOCAL_TIMEOUT_MS): Promise<CommandResult> {
        return this.deps.commands.run('git', args, {cwd, env: NO_PROMPTS, timeoutMs});
    }

    /** A git command that must succeed; its stdout, or StepFailed naming `step`. */
    private must(
        step: string,
        cwd: string | undefined,
        args: string[],
        timeoutMs = LOCAL_TIMEOUT_MS,
        env: Record<string, string> = {},
    ): Promise<string> {
        return this.run(step, 'git', args, cwd, timeoutMs, env);
    }

    private async run(
        step: string,
        command: string,
        args: string[],
        cwd: string | undefined,
        timeoutMs: number,
        env: Record<string, string> = {},
    ): Promise<string> {
        const result = await this.deps.commands.run(command, args, {cwd, env: {...NO_PROMPTS, ...env}, timeoutMs});
        if (result.exitCode === 0) return result.stdout;
        throw new StepFailed(step, failureText(command, result));
    }
}

// ── Rules ──

/**
 * What a hand-off left a copy as, kept in its marker: HEAD, the working
 * tree's hash (untracked included, ignored not), and the ticked files' blob
 * hashes, since those are usually ignored and so not in the tree. The next
 * hand-off compares against it to tell its own leftovers from work done on
 * the VM.
 */
export interface CopyRecord {
    head: string;
    tree: string;
    files: {path: string; blob: string}[];
}

/** The record in a marker's text, or null for an older marker, or one that is not ours. */
export function parseMarkerState(text: string | null): CopyRecord | null {
    if (text === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const state = (parsed as {state?: unknown} | null)?.state as Partial<CopyRecord> | undefined;
    if (!state || typeof state.head !== 'string' || typeof state.tree !== 'string' || !Array.isArray(state.files)) {
        return null;
    }
    const files = state.files.filter(
        (file): file is {path: string; blob: string} =>
            typeof file === 'object' && file !== null && typeof file.path === 'string' && typeof file.blob === 'string',
    );
    return {head: state.head, tree: state.tree, files};
}

/** Why a hand-off is refused before anything runs, or null. */
function refuseHandoff(message: HandoffMessage): string | null {
    const {repo, branch, headOid, files} = message;
    if (!isSafeFolderName(repo.name)) return `"${repo.name}" is not a folder name a copy can have`;
    if (repo.github !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.github)) {
        return `"${repo.github}" is not an owner/repo name`;
    }
    if (repo.github === undefined && repo.origin.startsWith('-')) return `"${repo.origin}" is not a repository URL`;
    if (!isPlausibleBranch(branch)) return `"${branch}" is not a branch name`;
    if (message.worktree !== undefined && !isSafeWorktreeName(message.worktree)) {
        return `"${message.worktree}" is not a worktree name`;
    }
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headOid)) return `"${headOid}" is not a commit id`;
    const unsafe = files.filter((file) => !isSafeRepoPath(file.path)).map((file) => file.path);
    if (unsafe.length) return `refused to write files outside the repository: ${unsafe.join(', ')}`;
    const total = files.reduce((sum, file) => sum + Buffer.from(file.contentBase64, 'base64').length, 0);
    if (total > HANDOFF_FILES_CAP_BYTES) {
        return `the files add up to ${total} bytes; a hand-off carries at most ${HANDOFF_FILES_CAP_BYTES}`;
    }
    return null;
}

/** One safe path segment: what `<baseFolder>/<name>` may add, and nothing more. */
export function isSafeFolderName(name: string): boolean {
    return isSafeRepoPath(name) && !name.includes('/') && !name.startsWith('-');
}

/**
 * One safe segment under `.claude/worktrees/`, and not a hidden one: a name
 * like `.git` or `..` must never steer the worktree, or its removal, anywhere
 * else, and `-x` must never read as an option.
 */
export function isSafeWorktreeName(name: string): boolean {
    return isSafeFolderName(name) && !name.startsWith('.');
}

/**
 * Whether `name` is a branch git would take, by `git check-ref-format`'s
 * rules, and one that can't be read as an option. Checked before it reaches
 * any command line.
 */
export function isPlausibleBranch(name: string): boolean {
    if (!name || name.startsWith('-') || name === '@' || name === 'HEAD') return false;
    // Control characters and space, then the characters git reserves for revisions.
    if ([...name].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)) return false;
    if (/[~^:?*[\\]/.test(name)) return false;
    if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
    if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
    return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/** `<baseFolder>/<name>`, with the base folder's form (a leading `~`) kept. */
export function joinDir(baseFolder: string, name: string): string {
    const base = baseFolder.trim().replace(/\/+$/, '');
    return `${base || '/'}${base ? '/' : ''}${name}`;
}

/** The main folder's marker, in the copy's `.git`. */
function markerPath(abs: string): string {
    return markerIn(`${abs.replace(/\/+$/, '')}/.git`);
}

/** The marker in a git dir: the copy's `.git`, or a worktree's `.git/worktrees/<n>`. */
function markerIn(gitDir: string): string {
    return `${gitDir.replace(/\/+$/, '')}/${COPY_MARKER}`;
}

/**
 * The folder whose operations a path's queue with: a worktree's are its
 * copy's, as they share one repository (its refs, its worktree list), so a
 * removal of a worktree can never land in the middle of a hand-off into the
 * same copy.
 */
export function lockKeyOf(abs: string): string {
    const trimmed = abs.replace(/\/+$/, '');
    const match = /^(.+)\/\.claude\/worktrees\/[^/]+$/.exec(trimmed);
    return match ? match[1] : trimmed;
}

/** One entry of `git worktree list --porcelain`: its path and its branch's short name, if any. */
export interface WorktreeEntry {
    path: string;
    branch: string | null;
}

/**
 * The entries of `git worktree list --porcelain`: blank-line separated
 * blocks of `worktree <path>`, `HEAD <oid>` and `branch refs/heads/<b>` (or
 * `detached`). The main folder comes first.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) entries.push({path: line.slice('worktree '.length), branch: null});
        else if (line.startsWith('branch refs/heads/') && entries.length) {
            entries[entries.length - 1].branch = line.slice('branch refs/heads/'.length);
        }
    }
    return entries;
}

/** Where a bundle's ref is fetched to: `HEAD` and `refs/heads/x` land under HANDOFF_REFS. */
function handoffRef(ref: string): string {
    return HANDOFF_REFS + (ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref);
}

/** The refs in `git bundle list-heads` output: `<oid> <ref>` lines. */
export function parseBundleHeads(stdout: string): string[] {
    return stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((ref): ref is string => !!ref);
}

/**
 * The paths in `git status --porcelain=v1 -z` output. Each entry is `XY path`
 * ended by NUL; a rename or copy is followed by its original path, which is
 * skipped.
 */
export function parsePorcelainZ(stdout: string): string[] {
    const fields = stdout.split('\0');
    const paths: string[] = [];
    for (let i = 0; i < fields.length; i++) {
        const entry = fields[i];
        if (entry.length < 4) continue;
        const status = entry.slice(0, 2);
        paths.push(entry.slice(3));
        if (status.includes('R') || status.includes('C')) i++;
    }
    return paths;
}

/** The commits in `git log --format=%H%x00%s` output, newest first as git prints them. */
export function parseCommits(stdout: string): CopyCommit[] {
    return stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const nul = line.indexOf('\0');
            return nul < 0 ? {oid: line, subject: ''} : {oid: line.slice(0, nul), subject: line.slice(nul + 1)};
        });
}

/** What a failed command said, trimmed to its tail, where git puts the reason. */
function failureText(command: string, result: CommandResult): string {
    const said = (result.stderr.trim() || result.stdout.trim()).replace(/\s*\n\s*/g, '\n');
    const tail = said.length > MAX_ERROR_CHARS ? '…' + said.slice(-MAX_ERROR_CHARS) : said;
    if (result.exitCode === null) return tail || `${command} did not run (not installed, or it timed out)`;
    return tail || `${command} exited with ${result.exitCode}`;
}

/** A few items for an error message, then how many more. */
function listed(items: string[], max = 10): string {
    return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
