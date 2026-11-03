/**
 * The Mac's side of project hand-off (#276 stage 2), behind the
 * `ProjectHandoff` façade.
 *
 * A hand-off makes or updates a copy of a local project on a VM host. The
 * agent clones origin with its own credentials; what origin does not have
 * goes from here: the unpushed commits as a git bundle, the uncommitted
 * changes as a binary patch (made through a temporary index, so the user's
 * staging is untouched), and the ignored config files the user ticked,
 * inline. On success the copy becomes a VM remote project whose `copyOf`
 * names the local one; that field is the only link between the two, and
 * `copiesOf`/`originOf` read it back.
 *
 * Work comes back only through git. Bring back asks the agent where the copy
 * stands, has it push its branch when origin lacks commits, then fetches the
 * branch here and checks it out in a worktree of the local project. Removing
 * a copy deletes its folder on the VM (the agent refuses anything it did not
 * make) and forgets the remote project; the local project is never touched.
 *
 * Questions for a host that cannot be reached answer null or a plain-words
 * error rather than throw, as `AgentHostsService` does.
 */
import {HANDOFF_FILES_CAP_BYTES, isSafeRepoPath} from '../../domain/agent/protocol';
import type {CopyStateMessage, HandoffFile} from '../../domain/agent/protocol';
import {
    copyDir,
    copyFolderName,
    HANDOFF_FILE_CAP_BYTES,
    isConfigCandidate,
    tickedByDefault,
} from '../../domain/agent/handoff';
import {parseRemoteProjectPath, remoteProjectPath} from '../../domain/project/remote-target';
import type {RemoteConfig} from '../../domain/project/remote-target';
import {gitHubRepository} from '../../domain/project/repo-url';
import type {RemoteProjectSetting} from '../../domain/settings/settings';
import type {Timers} from '../ports/clock';
import type {HandoffGit} from '../ports/handoff-git';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import {agentHostKey} from './agent-client/agent-client';
import type {AgentClient} from './agent-client/agent-client';
import type {AgentConnection} from './agent-client/agent-connection';
import {HOST_REACH_TIMEOUT_MS} from './agent-hosts-service';
import type {
    BringBackResult,
    CopyStatus,
    HandoffCandidate,
    HandoffHost,
    HandoffPreview,
    HandoffResult,
    ProjectCopy,
    ProjectHandoff,
} from './project-handoff';
import type {SettingsService} from './settings-service';
import {WORKTREES_DIR} from './support/branch-worktrees';

/** The names Bring back tries for its worktree's branch, in order, when the copy's own is taken here. */
const BRING_BACK_SUFFIXES = ['', '-vm', '-vm-2', '-vm-3'];

/** How many of a copy's uncommitted paths a refusal names before "and N more". */
const NAMED_PATHS = 5;

export interface ProjectHandoffServiceDeps {
    agents: Pick<AgentClient, 'connection'>;
    git: HandoffGit;
    settings: Pick<
        SettingsService,
        'remoteProjects' | 'findRemoteProject' | 'saveRemoteProject' | 'handoffFiles' | 'rememberHandoffFiles'
    >;
    renderer: Pick<RendererGateway, 'projectsChanged'>;
    /**
     * Forget a remote project exactly as the Projects list's Remove does: stop
     * the sessions the Mac holds for it, drop it from settings and tell the
     * renderer. Injected rather than redone here so the two never drift.
     */
    forgetRemoteProject(projectPath: string): void;
    timers: Timers;
    log: Logger;
    /** How long a question waits for the host's link to come up; HOST_REACH_TIMEOUT_MS by default. */
    reachTimeoutMs?: number;
}

/** An agent's answer, or why the agent could not be asked (kept apart: some answers carry an `error` of their own). */
type Asked<T> = {reached: true; answer: T} | {reached: false; error: string};

/** The local repository a hand-off starts from, once it is known to be one with an origin. */
interface LocalRepository {
    root: string;
    origin: string;
    branch: string;
    headOid: string;
}

export class ProjectHandoffService implements ProjectHandoff {
    constructor(private readonly deps: ProjectHandoffServiceDeps) {}

    public hosts(): HandoffHost[] {
        return [...this.agentHosts().values()].map((remote) => ({
            key: agentHostKey(remote),
            label: hostLabel(remote),
        }));
    }

    public async preview(localPath: string): Promise<HandoffPreview | {error: string}> {
        const repository = await this.localRepository(localPath);
        if ('error' in repository) return repository;
        const {git, settings} = this.deps;
        const [unpushed, uncommitted, offered] = await Promise.all([
            git.unpushedCount(repository.root),
            git.uncommittedPaths(repository.root),
            this.offered(repository.root),
        ]);
        const remembered = settings.handoffFiles(localPath);
        const candidates: HandoffCandidate[] = offered.map(({path, size}) => ({
            path,
            size,
            ticked: tickedByDefault(path, remembered),
        }));
        const existing: Record<string, string> = {};
        for (const copy of this.copiesOf(localPath)) existing[copy.hostKey] = copy.copyPath;
        return {branch: repository.branch, unpushed, uncommitted: uncommitted.length, candidates, existing};
    }

    public async handOff(
        localPath: string,
        hostKey: string,
        ticked: string[],
        onProgress: (line: string) => void = () => {},
    ): Promise<HandoffResult> {
        const {git, settings, renderer, log} = this.deps;
        const host = this.agentHosts().get(hostKey);
        if (!host) return {ok: false, error: `${hostKey} is not a VM with the Switchboard agent.`};
        const repository = await this.localRepository(localPath);
        if ('error' in repository) return {ok: false, error: repository.error};
        const {root} = repository;
        const label = hostLabel(host);

        // The files first: a refused or unreadable one fails before anything is uploaded.
        const chosen = [...new Set(ticked)];
        const files = await this.readTicked(root, chosen);
        if ('error' in files) return {ok: false, error: files.error};

        onProgress(`Connecting to ${label}`);
        let connection: AgentConnection;
        try {
            connection = await this.reach(host);
        } catch (err) {
            return {ok: false, error: `Could not reach ${label}: ${(err as Error).message}`};
        }
        const name = copyFolderName(root);

        let bundleUploadId: string | undefined;
        let patchUploadId: string | undefined;
        try {
            const bundle = await git.bundle(root);
            if (bundle) {
                onProgress(`Uploading the unpushed commits (${formatBytes(bundle.bytes.length)})`);
                bundleUploadId = await connection.upload(bundle.bytes, {sha256: bundle.sha256});
            }
        } catch (err) {
            return {ok: false, error: `Could not upload the unpushed commits: ${(err as Error).message}`};
        }
        try {
            const patch = await git.patch(root);
            if (patch) {
                onProgress(`Uploading the uncommitted changes (${formatBytes(patch.bytes.length)})`);
                patchUploadId = await connection.upload(patch.bytes, {sha256: patch.sha256});
            }
        } catch (err) {
            return {ok: false, error: `Could not upload the uncommitted changes: ${(err as Error).message}`};
        }

        onProgress(`Handing ${name} off to ${label}`);
        const github = gitHubRepository(repository.origin);
        let done;
        try {
            done = await connection.handoff(
                {
                    repo: {name, origin: repository.origin, ...(github ? {github} : {})},
                    branch: repository.branch,
                    headOid: repository.headOid,
                    ...(bundleUploadId ? {bundleUploadId} : {}),
                    ...(patchUploadId ? {patchUploadId} : {}),
                    files: files.files,
                },
                onProgress,
            );
        } catch (err) {
            return {ok: false, error: `The hand-off to ${label} stopped: ${(err as Error).message}`};
        }
        if (!done.ok) return {ok: false, error: done.error || `The hand-off to ${label} failed.`};

        const copy: RemoteProjectSetting = {
            user: host.user,
            host: host.host,
            port: host.port,
            dir: done.dir || copyDir(connection.settings?.baseFolder, name),
            ...(host.agent ? {agent: host.agent} : {}),
            copyOf: localPath,
        };
        const copyPath = remoteProjectPath(copy);
        settings.saveRemoteProject(copy);
        settings.rememberHandoffFiles(localPath, chosen);
        renderer.projectsChanged();
        log.info(`[handoff] ${localPath} → ${copyPath}${done.reused ? ' (updated)' : ''}`);
        return {ok: true, copyPath, reused: done.reused === true};
    }

    public copiesOf(localPath: string): ProjectCopy[] {
        return this.deps.settings
            .remoteProjects()
            .filter((remote) => remote.copyOf === localPath)
            .map((remote) => ({
                copyPath: remoteProjectPath(remote),
                hostKey: agentHostKey(remote),
                hostLabel: hostLabel(remote),
            }));
    }

    public originOf(copyPath: string): string | null {
        return this.deps.settings.findRemoteProject(copyPath)?.copyOf ?? null;
    }

    public async copyStatus(copyPath: string): Promise<CopyStatus | null> {
        const asked = await this.copyState(copyPath);
        if (!asked.ok) return null;
        const {state} = asked;
        return {branch: state.branch ?? null, unpushed: state.unpushed ?? [], uncommitted: state.uncommitted ?? []};
    }

    public async bringBack(copyPath: string, onProgress: (line: string) => void = () => {}): Promise<BringBackResult> {
        const {git} = this.deps;
        const localPath = this.originOf(copyPath);
        if (!localPath) return {ok: false, error: 'This project is not a copy of a local project.'};
        const root = await git.repositoryRoot(localPath);
        if (!root) return {ok: false, error: `${localPath} is no longer a git repository.`};

        onProgress('Checking the copy on the VM');
        const asked = await this.copyState(copyPath);
        if (!asked.ok) return {ok: false, error: asked.error};
        const {state} = asked;
        const branch = state.branch;
        if (!branch) return {ok: false, error: 'The copy is on a detached HEAD; check out a branch on the VM first.'};
        const uncommitted = state.uncommitted ?? [];
        if (uncommitted.length > 0) {
            return {
                ok: false,
                error: `The copy has uncommitted changes, which only come back committed: ${namePaths(uncommitted)}.`,
            };
        }

        const unpushed = state.unpushed ?? [];
        // Without an upstream origin may not have the branch at all, whatever the count says.
        if (unpushed.length > 0 || !state.upstream) {
            onProgress(
                unpushed.length > 0
                    ? `Pushing ${plural(unpushed.length, 'commit')} on ${branch} from the VM`
                    : `Pushing ${branch} from the VM`,
            );
            const pushed = await this.ask(copyPath, (connection, dir) => connection.pushBranch(dir, branch));
            if (!pushed.reached) return {ok: false, error: pushed.error};
            if (!pushed.answer.ok) {
                return {
                    ok: false,
                    error: `Could not push ${branch} from the VM: ${pushed.answer.error || 'git refused'}`,
                };
            }
        }

        onProgress(`Fetching ${branch}`);
        const fetched = await git.fetch(root, branch);
        if (!fetched.ok) return {ok: false, error: `Could not fetch ${branch}: ${fetched.reason}`};

        let lastReason = '';
        for (const suffix of BRING_BACK_SUFFIXES) {
            const local = branch + suffix;
            const worktree = root.replace(/\/+$/, '') + WORKTREES_DIR + local;
            onProgress(`Checking ${local} out in ${worktree}`);
            const added = await git.addWorktree(root, worktree, local, branch);
            if (added.ok) return {ok: true, worktree, branch: local};
            lastReason = added.reason;
            if (!added.taken) break;
            onProgress(`${added.reason}; trying another branch name`);
        }
        return {ok: false, error: `Could not add a worktree for ${branch}: ${lastReason}`};
    }

    public async removeCopy(copyPath: string): Promise<{ok: true} | {ok: false; error: string}> {
        if (!this.deps.settings.findRemoteProject(copyPath)?.copyOf) {
            return {ok: false, error: 'This project is not a hand-off copy, so Switchboard will not delete it.'};
        }
        const removed = await this.ask(copyPath, (connection, dir) => connection.removeCopy(dir));
        if (!removed.reached) return {ok: false, error: removed.error};
        if (!removed.answer.ok) return {ok: false, error: removed.answer.error || 'The VM did not delete the copy.'};
        this.deps.forgetRemoteProject(copyPath);
        return {ok: true};
    }

    // ── Helpers ──

    /** One remote with an agent per host, by `agentHostKey`: the hosts there are to hand off to. */
    private agentHosts(): Map<string, RemoteProjectSetting> {
        const hosts = new Map<string, RemoteProjectSetting>();
        for (const remote of this.deps.settings.remoteProjects()) {
            if (!remote.agent) continue;
            const key = agentHostKey(remote);
            if (!hosts.has(key)) hosts.set(key, remote);
        }
        return hosts;
    }

    /** The local repository with an origin, on a branch, with a commit; or why it cannot be handed off. */
    private async localRepository(localPath: string): Promise<LocalRepository | {error: string}> {
        const {git} = this.deps;
        const root = await git.repositoryRoot(localPath);
        if (!root) return {error: 'This folder is not a git repository, so there is nothing to hand off.'};
        const [origin, branch, headOid] = await Promise.all([
            git.originUrl(root),
            git.currentBranch(root),
            git.headOid(root),
        ]);
        if (!origin) return {error: 'This repository has no origin remote for the VM to clone from.'};
        if (!headOid) return {error: 'This repository has no commits yet.'};
        if (!branch) return {error: 'This repository is on a detached HEAD; check out a branch first.'};
        return {root, origin, branch, headOid};
    }

    /** The ignored files offered: config-like by name, regular files, under the per-file cap. */
    private async offered(root: string): Promise<{path: string; size: number}[]> {
        const named = (await this.deps.git.ignoredPaths(root)).filter(isConfigCandidate);
        const sizes = await this.deps.git.fileSizes(root, named);
        return named
            .filter((path) => {
                const size = sizes.get(path);
                return size !== undefined && size <= HANDOFF_FILE_CAP_BYTES;
            })
            .sort()
            .map((path) => ({path, size: sizes.get(path) ?? 0}));
    }

    /**
     * The ticked files, read. Only paths offered right now may go, so a stale
     * dialog or a crafted call cannot carry a tracked file or a key it never
     * showed; and they must add up to no more than one hand-off may carry.
     */
    private async readTicked(root: string, ticked: string[]): Promise<{files: HandoffFile[]} | {error: string}> {
        if (ticked.length === 0) return {files: []};
        const offered = new Set((await this.offered(root)).map((candidate) => candidate.path));
        const files: HandoffFile[] = [];
        let total = 0;
        for (const path of ticked) {
            if (!isSafeRepoPath(path) || !offered.has(path)) {
                return {error: `${path} is not one of the ignored config files that can be carried.`};
            }
            const file = await this.deps.git.readFile(root, path);
            if (!file) return {error: `Could not read ${path}.`};
            total += file.bytes.length;
            if (total > HANDOFF_FILES_CAP_BYTES) {
                return {error: `The ticked files add up to more than ${formatBytes(HANDOFF_FILES_CAP_BYTES)}.`};
            }
            files.push({path, contentBase64: Buffer.from(file.bytes).toString('base64'), mode: file.mode});
        }
        return {files};
    }

    /** The host's link, up; rejects when it cannot be had within the reach timeout. */
    private async reach(host: RemoteConfig): Promise<AgentConnection> {
        const connection = this.deps.agents.connection(host);
        if (connection.state === 'failed') connection.retryNow();
        await withTimeout(
            connection.whenConnected(),
            this.deps.reachTimeoutMs ?? HOST_REACH_TIMEOUT_MS,
            this.deps.timers,
        );
        return connection;
    }

    /** Ask a copy's agent something about its folder; a plain-words error when it cannot be asked. */
    private async ask<T>(
        copyPath: string,
        question: (connection: AgentConnection, dir: string) => Promise<T>,
    ): Promise<Asked<T>> {
        const parsed = parseRemoteProjectPath(copyPath);
        if (!parsed?.dir) return {reached: false, error: 'This project is not a copy on a VM.'};
        const label = hostLabel(parsed);
        try {
            const connection = await this.reach(parsed);
            return {reached: true, answer: await question(connection, parsed.dir)};
        } catch (err) {
            this.deps.log.warn(`[handoff] could not ask ${label} about ${parsed.dir}: ${(err as Error).message}`);
            return {reached: false, error: `Could not reach ${label}: ${(err as Error).message}`};
        }
    }

    /** Where the copy stands, as the agent answered; or why it could not say. */
    private async copyState(
        copyPath: string,
    ): Promise<{ok: true; state: CopyStateMessage} | {ok: false; error: string}> {
        const asked = await this.ask(copyPath, (connection, dir) => connection.copyStatus(dir));
        if (!asked.reached) return {ok: false, error: asked.error};
        if (!asked.answer.ok) return {ok: false, error: asked.answer.error || 'The VM could not read the copy.'};
        return {ok: true, state: asked.answer};
    }
}

/** What the picker calls a host: `user@host`, with the port when it is not 22. */
function hostLabel(host: Pick<RemoteConfig, 'user' | 'host' | 'port'>): string {
    const port = Number(host.port) || 22;
    return `${host.user}@${host.host}${port === 22 ? '' : `:${port}`}`;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function namePaths(paths: readonly string[]): string {
    const named = paths.slice(0, NAMED_PATHS).join(', ');
    return paths.length > NAMED_PATHS ? `${named} and ${paths.length - NAMED_PATHS} more` : named;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, timers: Timers): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = timers.setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
        promise.then(
            (value) => {
                timers.clearTimeout(timer);
                resolve(value);
            },
            (err: unknown) => {
                timers.clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            },
        );
    });
}
