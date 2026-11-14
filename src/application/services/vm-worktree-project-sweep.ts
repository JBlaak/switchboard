/**
 * Dropping the VM worktree projects whose worktree is already gone.
 *
 * The archive cleanup drops a VM worktree's project record as it removes the
 * worktree (`WorktreeCleanupService.removed`). Records left from before that,
 * or from a worktree removed some other way, are swept on every connect to
 * the VM: each worktree project on that host with no session still listed
 * (none, or all archived) is checked with git, and dropped when git no longer
 * finds its folder.
 *
 * Only a folder under `.claude/worktrees/` is ever looked at, never a project
 * the user added. And only when git answers for the repository the worktree
 * was made in: a link that fails mid-sweep leaves everything as it was.
 */
import {worktreeProjectCandidates} from '../../domain/project/vm-worktree-projects';
import type {VmHost} from '../../domain/agent/vm-paths';
import type {GitWorkspace} from '../ports/git-workspace';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {SettingsService} from './settings-service';

export interface VmWorktreeProjectSweepDeps {
    settings: Pick<SettingsService, 'remoteProjects' | 'removeRemoteProject'>;
    /** Routes VM-named paths to that VM's git. */
    git: Pick<GitWorkspace, 'worktreeRoot'>;
    /** Whether a session is archived; a project with any session that is not stays. */
    archived(sessionId: string): boolean;
    renderer: Pick<RendererGateway, 'projectsChanged'>;
    log: Logger;
}

export class VmWorktreeProjectSweep {
    private readonly running = new Set<string>();

    constructor(private readonly deps: VmWorktreeProjectSweepDeps) {}

    /** Sweep `host`, just connected; never throws. */
    public async connected(host: VmHost): Promise<void> {
        const key = `${host.user}@${host.host}:${host.port}`;
        if (this.running.has(key)) return;
        this.running.add(key);
        try {
            await this.sweep(host);
        } catch (err) {
            this.deps.log.warn(`[worktree-projects] ${key}: ${(err as Error).message}`);
        } finally {
            this.running.delete(key);
        }
    }

    private async sweep(host: VmHost): Promise<void> {
        const {settings, git, log} = this.deps;
        const candidates = worktreeProjectCandidates(settings.remoteProjects(), host, this.deps.archived);
        const repositories = new Map<string, string | null>();
        const gone: string[] = [];
        for (const candidate of candidates) {
            if (!repositories.has(candidate.repository)) {
                repositories.set(candidate.repository, await git.worktreeRoot(candidate.repository));
            }
            const repository = repositories.get(candidate.repository);
            // No answer for the repository: the link, or the repository, is not
            // there to ask. Nothing can be told about its worktrees.
            if (!repository) continue;
            const root = await git.worktreeRoot(candidate.path);
            // A folder git finds as a worktree of its own is still there. One
            // that only resolves to the repository is a leftover directory, no
            // worktree any more.
            if (root && root !== repository) continue;
            gone.push(candidate.path);
        }
        for (const path of gone) {
            settings.removeRemoteProject(path);
            log.info(`[worktree-projects] dropped ${path}: its worktree is gone`);
        }
        if (gone.length > 0) this.deps.renderer.projectsChanged();
    }
}
