/**
 * The git adapters the Mac's services get: local or VM, picked by path (#276 stage 4).
 *
 * A VM path is named `ssh://user@host[:port]//abs` (`domain/agent/vm-paths`).
 * When its host runs an agent, the call goes to a GitCliWorkspace (or
 * GitCliRemotes) over that host's VmGitRunner, made once per host and kept.
 * Everything else, local paths and paths on an agentless (ssh+tmux) remote,
 * goes to the local instance and is answered exactly as before: for an
 * agentless remote that is git failing on a folder the Mac does not have, so
 * `worktreeRoot` is null, `status` empty and so on.
 *
 * A call is routed by its first path (the working directory, or the
 * repository). A second path in the same call (`addWorktree`'s worktree) has
 * to be on the same host; the VM instance answers a failed write otherwise.
 *
 * GitHub needs no router: every GitHubCli call names its repository
 * (`--repo owner/name`, or GraphQL with the owner and name as variables) and
 * none depends on a folder, so the Mac's own `gh` answers for a VM project
 * once RoutingGitRemotes has read that project's origin.
 */
import {splitVmPath, vmHostKey} from '../../domain/agent/vm-paths';
import type {VmHost} from '../../domain/agent/vm-paths';
import type {FileChange, LineStats} from '../../domain/session-work/model';
import type {WorktreeSummary} from '../../domain/project/overview';
import type {Disposable, GitWorkspace, GitWorktrees, GitWrite} from '../../application/ports/git-workspace';
import type {GitRemotes} from '../../application/ports/git-remotes';
import {GitCliWorkspace} from './git-cli-workspace';
import {GitCliRemotes} from './git-cli-remotes';
import {VmGitRunner} from './vm-git-runner';
import type {AgentTools} from './vm-git-runner';

/** How the routers learn which hosts run an agent, and reach it. */
export interface VmGitRouting {
    /** Whether `host` runs an agent; a remote without one is answered locally, as before. */
    isAgentHost(host: VmHost): boolean;
    /** The host's agent connection (AgentClient.connection). */
    tools(host: VmHost): AgentTools;
}

/** One instance per agent host, made on first use; null for a path that stays local. */
class PerHost<T> {
    private readonly made = new Map<string, T>();

    constructor(
        private readonly routing: VmGitRouting,
        private readonly make: (runner: VmGitRunner) => T,
    ) {}

    public forPath(name: string): T | null {
        const split = splitVmPath(name);
        if (!split || !this.routing.isAgentHost(split.host)) return null;
        const key = vmHostKey(split.host);
        let instance = this.made.get(key);
        if (!instance) {
            const host = split.host;
            instance = this.make(new VmGitRunner(host, () => this.routing.tools(host)));
            this.made.set(key, instance);
        }
        return instance;
    }
}

type Workspace = GitWorkspace & GitWorktrees;

export class RoutingGitWorkspace implements GitWorkspace, GitWorktrees {
    private readonly vms: PerHost<Workspace>;

    constructor(
        private readonly local: Workspace,
        routing: VmGitRouting,
    ) {
        this.vms = new PerHost(routing, (runner) => new GitCliWorkspace(runner));
    }

    /** The instance that answers for `name`. */
    private on(name: string): Workspace {
        return this.vms.forPath(name) ?? this.local;
    }

    public worktreeRoot(cwd: string): Promise<string | null> {
        return this.on(cwd).worktreeRoot(cwd);
    }

    public defaultBranch(worktree: string): Promise<string> {
        return this.on(worktree).defaultBranch(worktree);
    }

    public currentBranch(worktree: string): Promise<string | null> {
        return this.on(worktree).currentBranch(worktree);
    }

    public commitSha(worktree: string, ref: string): Promise<string | null> {
        return this.on(worktree).commitSha(worktree, ref);
    }

    public branchExists(worktree: string, branch: string): Promise<boolean> {
        return this.on(worktree).branchExists(worktree, branch);
    }

    public isPushed(worktree: string, branch: string): Promise<boolean> {
        return this.on(worktree).isPushed(worktree, branch);
    }

    public aheadBehind(worktree: string, branch: string, base: string): Promise<{ahead: number; behind: number}> {
        return this.on(worktree).aheadBehind(worktree, branch, base);
    }

    public branchDiff(worktree: string, branch: string, base: string): Promise<string> {
        return this.on(worktree).branchDiff(worktree, branch, base);
    }

    public branchLineStats(worktree: string, branch: string, base: string): Promise<LineStats> {
        return this.on(worktree).branchLineStats(worktree, branch, base);
    }

    public status(worktree: string): Promise<FileChange[]> {
        return this.on(worktree).status(worktree);
    }

    public workingDiff(worktree: string): Promise<string> {
        return this.on(worktree).workingDiff(worktree);
    }

    public workingLineStats(worktree: string): Promise<LineStats> {
        return this.on(worktree).workingLineStats(worktree);
    }

    public mergeBase(worktree: string, branch: string, base: string): Promise<string | null> {
        return this.on(worktree).mergeBase(worktree, branch, base);
    }

    public blobSizes(worktree: string, revision: string, paths: readonly string[]): Promise<Map<string, number>> {
        return this.on(worktree).blobSizes(worktree, revision, paths);
    }

    public blob(worktree: string, revision: string, file: string): Promise<Uint8Array | null> {
        return this.on(worktree).blob(worktree, revision, file);
    }

    public workingFileSizes(worktree: string, paths: readonly string[]): Promise<Map<string, number>> {
        return this.on(worktree).workingFileSizes(worktree, paths);
    }

    public workingFile(worktree: string, file: string): Promise<Uint8Array | null> {
        return this.on(worktree).workingFile(worktree, file);
    }

    public generatedPaths(worktree: string, paths: readonly string[]): Promise<string[]> {
        return this.on(worktree).generatedPaths(worktree, paths);
    }

    public worktrees(repository: string): Promise<WorktreeSummary[]> {
        return this.on(repository).worktrees(repository);
    }

    public watch(worktree: string, onChange: () => void): Disposable {
        return this.on(worktree).watch(worktree, onChange);
    }

    public mainCheckout(cwd: string): Promise<string | null> {
        return this.on(cwd).mainCheckout(cwd);
    }

    public fetchBranch(repository: string, branch: string): Promise<GitWrite> {
        return this.on(repository).fetchBranch(repository, branch);
    }

    public addWorktree(repository: string, worktree: string, branch: string, base: string): Promise<GitWrite> {
        return this.on(repository).addWorktree(repository, worktree, branch, base);
    }

    public checkoutWorktree(repository: string, worktree: string, branch: string): Promise<GitWrite> {
        return this.on(repository).checkoutWorktree(repository, worktree, branch);
    }

    public removeWorktree(repository: string, worktree: string, options?: {force?: boolean}): Promise<GitWrite> {
        return this.on(repository).removeWorktree(repository, worktree, options);
    }

    public pruneWorktrees(repository: string): Promise<GitWrite> {
        return this.on(repository).pruneWorktrees(repository);
    }

    public deleteBranch(repository: string, branch: string): Promise<GitWrite> {
        return this.on(repository).deleteBranch(repository, branch);
    }
}

export class RoutingGitRemotes implements GitRemotes {
    private readonly vms: PerHost<GitRemotes>;

    constructor(
        private readonly local: GitRemotes,
        routing: VmGitRouting,
    ) {
        this.vms = new PerHost(routing, (runner) => new GitCliRemotes(runner));
    }

    public originUrl(projectPath: string): Promise<string | null> {
        return (this.vms.forPath(projectPath) ?? this.local).originUrl(projectPath);
    }
}
