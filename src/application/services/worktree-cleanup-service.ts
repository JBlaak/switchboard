/**
 * Removing the worktrees a session worked in once it is archived, when the
 * user has switched that on in Settings.
 *
 * Where the session worked is what its transcripts say, as on the Session
 * work page: the directory it started in and every `cwd` its lines, and its
 * subagents', were written from, each resolved to its worktree. Which of those
 * may go is `worktreeVerdicts`'s call; git itself refuses anything dirty or
 * locked as well, since nothing here forces a removal.
 *
 * It runs after the archive and on its own: a worktree that stays or a git
 * that refuses is logged, and the archive stands either way. Sessions on a
 * remote without an agent are left alone: their worktrees are on a machine
 * git cannot reach. A VM session's are cleaned on the VM, through the git
 * that its VM-named paths route there (#276 stage 4), and the project record
 * the VM worktree's session left is dropped with it, through `removed`.
 */
import {isRemoteProjectPath, parseRemoteProjectPath} from '../../domain/project/remote-target';
import {worktreeVerdicts} from '../../domain/session-work/worktree-cleanup';
import type {GitWorkspace, GitWorktrees} from '../ports/git-workspace';
import type {Logger} from '../ports/logger';
import type {AwaitableTranscriptStore} from '../ports/transcript-queries';
import type {SessionWorkTarget} from './session-work-service';

export interface WorktreeCleanupDeps {
    /** The global setting, read at each archive. */
    enabled(): boolean;
    /** Where a session lives, or null when no session goes by that id. */
    locate(sessionId: string): SessionWorkTarget | null;
    /** Answered now for a local session, later for a VM one (#276 stage 4). */
    transcripts: Pick<AwaitableTranscriptStore, 'locations'>;
    git: Pick<GitWorkspace, 'worktreeRoot' | 'worktrees'> & Pick<GitWorktrees, 'mainCheckout' | 'removeWorktree'>;
    /** The directories every session but this one works in: running, or listed and not archived. */
    otherSessionPaths(sessionId: string): string[];
    log: Logger;
    /**
     * Whether a path is on a remote with no Switchboard agent, whose worktrees
     * are left alone: out of git's reach. A VM session's git runs on the VM, so
     * its worktrees are cleaned there. Without it, every remote is left alone,
     * as before #276 stage 4.
     */
    agentlessRemote?: (path: string) => boolean;
    /**
     * A worktree was removed: drop what lists it. A VM worktree's folder has a
     * project record of its own (made when its session started), which would
     * otherwise stay listed with no sessions once the folder is gone. A local
     * worktree's row goes with its sessions, so nothing is needed for it.
     */
    removed?: (worktree: string) => void;
}

export class WorktreeCleanupService {
    constructor(private readonly deps: WorktreeCleanupDeps) {}

    /** Remove what `sessionId`, just archived, leaves behind; never throws. */
    public async afterArchive(sessionId: string): Promise<void> {
        if (!this.deps.enabled()) return;
        try {
            await this.clean(sessionId);
        } catch (err) {
            this.deps.log.warn(`[worktree-cleanup] ${sessionId}: ${(err as Error).message}`);
        }
    }

    private async clean(sessionId: string): Promise<void> {
        const target = this.deps.locate(sessionId);
        if (!target || (this.deps.agentlessRemote ?? isRemoteProjectPath)(target.projectPath)) return;

        const cwds = [target.projectPath];
        if (target.folder)
            cwds.push(...(await this.deps.transcripts.locations(target.folder, sessionId)).map((entry) => entry.cwd));

        // Each worktree under the repository it belongs to, which is where git lists it.
        const byRepository = new Map<string, Set<string>>();
        for (const cwd of new Set(cwds)) {
            const root = await this.deps.git.worktreeRoot(cwd);
            if (!root) continue;
            const repository = await this.deps.git.mainCheckout(root);
            if (!repository) continue;
            if (!byRepository.has(repository)) byRepository.set(repository, new Set());
            byRepository.get(repository)!.add(root);
        }
        if (byRepository.size === 0) return;

        const inUse = await this.inUse(sessionId, target.projectPath);
        for (const [repository, worked] of byRepository) {
            const checkouts = await this.deps.git.worktrees(repository);
            for (const verdict of worktreeVerdicts([...worked], checkouts, inUse)) {
                if (!verdict.remove) {
                    // The main checkout is where most sessions work; keeping it is no news.
                    if (verdict.reason !== 'the main checkout') {
                        this.deps.log.info(`[worktree-cleanup] ${sessionId}: kept ${verdict.path}, ${verdict.reason}`);
                    }
                    continue;
                }
                const removed = await this.deps.git.removeWorktree(repository, verdict.path);
                if (removed.ok) this.deps.removed?.(verdict.path);
                this.deps.log.info(
                    `[worktree-cleanup] ${sessionId}: ${
                        removed.ok ? `removed ${verdict.path}` : `could not remove ${verdict.path}: ${removed.reason}`
                    }`,
                );
            }
        }
    }

    /**
     * The directories the other sessions work in. On a VM, one directory has
     * two names: a project added as `~/projects/site` and the absolute
     * `/home/dev/projects/site` git answers with. So for a VM session, each
     * other session's directory on the same host is also named as git names
     * its worktree, or a worktree another session works in would look free.
     */
    private async inUse(sessionId: string, projectPath: string): Promise<string[]> {
        const paths = this.deps.otherSessionPaths(sessionId);
        const host = parseRemoteProjectPath(projectPath);
        if (!host) return paths;
        const sameHost = paths.filter((path) => {
            const other = parseRemoteProjectPath(path);
            return other !== null && other.user === host.user && other.host === host.host && other.port === host.port;
        });
        const roots = await Promise.all([...new Set(sameHost)].map((path) => this.deps.git.worktreeRoot(path)));
        return [...paths, ...roots.filter((root): root is string => root !== null)];
    }
}
