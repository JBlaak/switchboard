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
                    answer({ok: true, dir, reused});
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

    /** The hand-off's steps, in order; true when an existing copy was updated. Throws StepFailed. */
    private async makeCopy(
        message: HandoffMessage,
        dir: string,
        abs: string,
        progress: (line: string) => void,
        uploads: {bundle: string | null; patch: string | null},
    ): Promise<boolean> {
        const {repo, branch, headOid} = message;
        const reused = this.deps.files.exists(abs);

        if (reused) {
            const step = `Checking the copy at ${dir}`;
            progress(step);
            if (!this.deps.files.exists(markerPath(abs))) {
                throw new StepFailed(
                    step,
                    `${dir} already exists and is not a copy Switchboard made; move it away or change the base folder`,
                );
            }
            const dirty = parsePorcelainZ(await this.must(step, abs, ['status', '--porcelain=v1', '-z']));
            if (dirty.length) {
                throw new StepFailed(
                    step,
                    `the copy has uncommitted changes of its own: ${listed(dirty)}. Commit, push or discard them on the VM first`,
                );
            }
            const fetchStep = 'Fetching origin';
            progress(fetchStep);
            await this.must(fetchStep, abs, ['fetch', '--prune', 'origin'], NETWORK_TIMEOUT_MS);
        } else {
            const step = repo.github ? `Cloning ${repo.github} into ${dir}` : `Cloning ${repo.origin} into ${dir}`;
            progress(step);
            // gh clones with the VM's own login and preferred protocol; a
            // repository not on GitHub falls back to plain git and whatever
            // credentials the VM has for its host.
            if (repo.github)
                await this.run(step, 'gh', ['repo', 'clone', repo.github, abs], undefined, NETWORK_TIMEOUT_MS);
            else await this.must(step, undefined, ['clone', '--', repo.origin, abs], NETWORK_TIMEOUT_MS);
            // Marked straight away, so a hand-off that fails further on still
            // leaves a copy the next one may reuse and Remove may delete.
            this.writeMarker(step, abs, repo.origin);
        }

        const fetched: string[] = [];
        if (uploads.bundle) {
            const step = 'Fetching your unpushed commits';
            progress(step);
            await this.must(step, abs, ['bundle', 'verify', uploads.bundle]);
            const heads = parseBundleHeads(await this.must(step, abs, ['bundle', 'list-heads', uploads.bundle]));
            if (!heads.length) throw new StepFailed(step, 'the bundle holds no refs');
            const refspecs = heads.map((ref) => `+${ref}:${handoffRef(ref)}`);
            await this.must(step, abs, ['fetch', '--no-tags', uploads.bundle, ...refspecs]);
            fetched.push(...heads.map(handoffRef));
        }

        const checkoutStep = `Checking out ${branch}`;
        progress(checkoutStep);
        const hasHead = await this.git(abs, ['cat-file', '-e', `${headOid}^{commit}`]);
        if (hasHead.exitCode !== 0) {
            throw new StepFailed(
                checkoutStep,
                `commit ${headOid.slice(0, 12)} is not on origin or in the bundle; push it, or hand off again`,
            );
        }
        if (reused) await this.refuseLosingCommits(checkoutStep, abs, branch, headOid);
        await this.must(checkoutStep, abs, ['checkout', '--no-track', '-B', branch, headOid]);
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
            await this.must(step, abs, ['apply', '--binary', '--whitespace=nowarn', uploads.patch]);
        }

        if (message.files.length) {
            const step = `Writing ${message.files.length} ${message.files.length === 1 ? 'file' : 'files'}`;
            progress(step);
            for (const file of message.files) {
                try {
                    this.deps.files.writeInside(
                        abs,
                        file.path,
                        Buffer.from(file.contentBase64, 'base64'),
                        file.mode & MODE_MASK || 0o644,
                    );
                } catch (err) {
                    throw new StepFailed(step, `${file.path}: ${errorText(err)}`);
                }
            }
        }

        if (reused) this.writeMarker('Marking the copy', abs, repo.origin);
        return reused;
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

    private writeMarker(step: string, abs: string, origin: string): void {
        const content = JSON.stringify({handedOffAt: new Date(this.deps.clock.now()).toISOString(), origin}) + '\n';
        try {
            this.deps.files.writeFileAtomic(markerPath(abs), Buffer.from(content, 'utf8'), 0o644);
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
            if ('error' in checked) {
                this.deps.log.warn(`[copies] refused to remove ${message.dir}: ${checked.error}`);
                return answer(checked.error);
            }
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
     */
    private checkRemoval(dir: string, abs: string): {real: string} | {error: string} {
        const {files} = this.deps;
        const baseFolder = this.deps.hostSettings().baseFolder;
        const base = files.realpath(expandHome(baseFolder, this.deps.home));
        if (base === null) return {error: `the base folder ${baseFolder} does not exist`};
        const real = files.realpath(abs);
        if (real === null) return {error: `${dir} does not exist`};
        if (real === base || !real.startsWith(base.replace(/\/+$/, '') + '/')) {
            return {error: `${dir} is not inside the base folder ${baseFolder}`};
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
        const key = abs.replace(/\/+$/, '');
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
    private must(step: string, cwd: string | undefined, args: string[], timeoutMs = LOCAL_TIMEOUT_MS): Promise<string> {
        return this.run(step, 'git', args, cwd, timeoutMs);
    }

    private async run(
        step: string,
        command: string,
        args: string[],
        cwd: string | undefined,
        timeoutMs: number,
    ): Promise<string> {
        const result = await this.deps.commands.run(command, args, {cwd, env: NO_PROMPTS, timeoutMs});
        if (result.exitCode === 0) return result.stdout;
        throw new StepFailed(step, failureText(command, result));
    }
}

// ── Rules ──

/** Why a hand-off is refused before anything runs, or null. */
function refuseHandoff(message: HandoffMessage): string | null {
    const {repo, branch, headOid, files} = message;
    if (!isSafeFolderName(repo.name)) return `"${repo.name}" is not a folder name a copy can have`;
    if (repo.github !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.github)) {
        return `"${repo.github}" is not an owner/repo name`;
    }
    if (repo.github === undefined && repo.origin.startsWith('-')) return `"${repo.origin}" is not a repository URL`;
    if (!isPlausibleBranch(branch)) return `"${branch}" is not a branch name`;
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

function markerPath(abs: string): string {
    return `${abs.replace(/\/+$/, '')}/.git/${COPY_MARKER}`;
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
