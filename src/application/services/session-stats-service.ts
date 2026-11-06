/**
 * A session's stats for the session tray (#341): context used, messages,
 * running time, branch and shell.
 *
 * Asked fresh each time (the tray asks when it opens), so a checkout in the
 * session's worktree shows on the next ask without a watcher. Every part
 * answers on its own: one that cannot be read is null and the rest still
 * answer. A remote session has what its transcript and git can be reached
 * for: a VM session's are asked of its agent, an agentless (ssh+tmux) one has
 * no transcript or git here.
 */
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {contextFraction, lastContextUsage, lastCwd, type SessionStats} from '../../domain/session/stats';
import type {GitWorkspace} from '../ports/git-workspace';
import type {Logger} from '../ports/logger';
import type {AwaitableTranscriptStore} from '../ports/transcript-queries';

/**
 * How much of the transcript's end is read for the last usage and `cwd`.
 * A turn writes a few lines, but one of them can carry a large tool result.
 */
export const STATS_TAIL_BYTES = 1024 * 1024;

const UNKNOWN: SessionStats = {contextUsed: null, messageCount: null, startedAt: null, branch: null, shell: null};

export interface SessionStatsServiceDeps {
    /** Where a session's transcripts live and the directory it was started in; null for no such session. */
    locate(sessionId: string): {folder: string | null; projectPath: string} | null;
    /** Answered now for a local session, later for a VM one. */
    transcripts: Pick<AwaitableTranscriptStore, 'readTail' | 'readSession'>;
    /** The session list's row for it, when it has been indexed. */
    cached(sessionId: string): {messageCount: number; created: string} | null;
    /** When the running session's terminal started (epoch ms); null when it is not running. */
    openedAt(sessionId: string): number | null;
    git: Pick<GitWorkspace, 'currentBranch'>;
    /** The name of the shell profile a project's sessions run in; null for the default one. */
    shellName(projectPath: string): string | null;
    /** Whether a path is on a remote with no Switchboard agent: no git there to ask. */
    agentlessRemote(path: string): boolean;
    log: Logger;
}

export class SessionStatsService {
    constructor(private readonly deps: SessionStatsServiceDeps) {}

    public async stats(sessionId: string): Promise<SessionStats> {
        const target = this.deps.locate(sessionId);
        if (!target) return UNKNOWN;
        const {folder, projectPath} = target;
        const remote = isRemoteProjectPath(projectPath);

        const lines = folder
            ? (await this.attempt(() => this.deps.transcripts.readTail(folder, sessionId, STATS_TAIL_BYTES), '')).split(
                  '\n',
              )
            : [];
        const counted = await this.counted(sessionId, folder, projectPath);
        const openedAt = this.deps.openedAt(sessionId);

        return {
            contextUsed: contextFraction(lastContextUsage(lines)),
            messageCount: counted?.messageCount ?? null,
            startedAt: openedAt !== null ? new Date(openedAt).toISOString() : (counted?.created ?? null),
            branch: await this.branch(projectPath, remote ? null : lastCwd(lines)),
            shell: remote ? null : this.deps.shellName(projectPath),
        };
    }

    /** The session list's count and start, read from the transcript when it is not indexed yet. */
    private async counted(
        sessionId: string,
        folder: string | null,
        projectPath: string,
    ): Promise<{messageCount: number; created: string} | null> {
        const cached = this.deps.cached(sessionId);
        if (cached) return cached;
        if (!folder) return null;
        return this.attempt(() => this.deps.transcripts.readSession(folder, sessionId, projectPath), null);
    }

    /**
     * The branch checked out where the session works now: the directory its
     * transcript last wrote from (a worktree it moved into), else the one it
     * was started in. A VM session's is asked of its agent by project path.
     */
    private async branch(projectPath: string, cwd: string | null): Promise<string | null> {
        if (this.deps.agentlessRemote(projectPath)) return null;
        return this.attempt(() => this.deps.git.currentBranch(cwd ?? projectPath), null);
    }

    private async attempt<T>(read: () => T | Promise<T>, fallback: T): Promise<T> {
        try {
            return await read();
        } catch (err) {
            this.deps.log.warn('[session-stats] a read failed:', (err as Error).message);
            return fallback;
        }
    }
}
