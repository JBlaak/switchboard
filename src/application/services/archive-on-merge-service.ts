/**
 * Archiving a landed PR's session when the PR merges (#440, for #432).
 *
 * The Merge manager says which PRs just merged (`merged`); this finds the
 * sessions that opened them and archives each by `mergedSessionVerdict`:
 * idle ones right away, busy ones at the end of their turn (`turnEnded`, from
 * the archive tool's turn followers), and never one with uncommitted changes
 * in a worktree it worked in.
 *
 * Where a session worked is what its transcripts say, as for the worktree
 * cleanup: the directory it started in and every `cwd` its lines name. A
 * session on a remote without an agent is out of git's reach, so its changes
 * cannot be seen and it is left as it is.
 *
 * The archive is the archive tool's (`sessionArchiver`): stopped, row
 * archived, window told, so the window throws the confetti for it.
 */
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {
    mergedSessionVerdict,
    sessionsOfMerged,
    type MergedPullRequestRef,
    type SessionPullRequestRef,
} from '../../domain/merge-manager/archive-on-merge';
import type {GitWorkspace} from '../ports/git-workspace';
import type {Logger} from '../ports/logger';
import type {SessionPrompter} from '../ports/session-prompter';
import type {AwaitableTranscriptStore} from '../ports/transcript-queries';
import type {SessionWorkTarget} from './session-work-service';

/** A listed or running session, with the PRs its row knows. */
export interface MergedSessionCandidate {
    readonly sessionId: string;
    readonly archived?: boolean;
    readonly pullRequests: readonly SessionPullRequestRef[];
}

export interface ArchiveOnMergeDeps {
    /** Every listed and running session. */
    sessions(): MergedSessionCandidate[];
    prompter: Pick<SessionPrompter, 'runningId' | 'isBusy'>;
    /** Where a session lives, or null when no session goes by that id. */
    locate(sessionId: string): SessionWorkTarget | null;
    transcripts: Pick<AwaitableTranscriptStore, 'locations'>;
    git: Pick<GitWorkspace, 'worktreeRoot' | 'status'>;
    /** Stops the session and archives its row, as the archive tool does. */
    archiver: {archive(sessionId: string): {ok: boolean}};
    log: Logger;
    /** Whether a path is on a remote with no Switchboard agent; without it, every remote is. */
    agentlessRemote?: (path: string) => boolean;
}

export class ArchiveOnMergeService {
    /** Sessions (by the id they went by) to archive when their turn ends. */
    private readonly deferred = new Set<string>();

    constructor(private readonly deps: ArchiveOnMergeDeps) {}

    /** These PRs merged: archive their sessions, now or at the end of their turn. Never throws. */
    public async merged(prs: readonly MergedPullRequestRef[]): Promise<void> {
        if (prs.length === 0) return;
        for (const session of sessionsOfMerged(this.deps.sessions(), prs)) {
            await this.settle(session.sessionId).catch((err) =>
                this.deps.log.warn(`[archive-on-merge] ${session.sessionId}: ${(err as Error).message}`),
            );
        }
    }

    /**
     * A turn ended (the archive tool's turn followers): a deferred session is
     * archived now, unless it asked to be archived itself (it is, right after)
     * or left uncommitted changes.
     */
    public turnEnded(sessionIds: readonly string[], archiving: boolean, currentId: string): void {
        const deferred = sessionIds.filter((id) => this.deferred.has(id));
        if (deferred.length === 0) return;
        for (const id of deferred) this.deferred.delete(id);
        if (archiving) return;
        void this.dirty(currentId)
            .then((dirty) => {
                if (dirty) {
                    this.deps.log.info(`[archive-on-merge] ${currentId}: uncommitted changes after its turn; kept`);
                    return;
                }
                this.archive(currentId);
            })
            .catch((err) => this.deps.log.warn(`[archive-on-merge] ${currentId}: ${(err as Error).message}`));
    }

    /** Whether a session waits for its turn to end to be archived. */
    public isDeferred(sessionId: string): boolean {
        return this.deferred.has(sessionId);
    }

    private async settle(sessionId: string): Promise<void> {
        const running = this.deps.prompter.runningId(sessionId);
        const busy = running !== null && this.deps.prompter.isBusy(running);
        const dirty = await this.dirty(running ?? sessionId);
        switch (mergedSessionVerdict({busy, dirty})) {
            case 'keep':
                this.deps.log.info(
                    `[archive-on-merge] ${sessionId}: its PR merged, but it has uncommitted changes; kept`,
                );
                return;
            case 'defer':
                this.deferred.add(running ?? sessionId);
                this.deps.log.info(`[archive-on-merge] ${sessionId}: its PR merged; archived at the end of its turn`);
                return;
            case 'archive':
                this.archive(running ?? sessionId);
        }
    }

    private archive(sessionId: string): void {
        const {ok} = this.deps.archiver.archive(sessionId);
        this.deps.log.info(
            `[archive-on-merge] ${sessionId}: ${ok ? 'its PR merged; archived' : 'could not be stopped; left as it is'}`,
        );
    }

    /** Does any worktree the session worked in have uncommitted changes? True when that cannot be seen. */
    private async dirty(sessionId: string): Promise<boolean> {
        const target = this.deps.locate(sessionId);
        if (!target) return false;
        if ((this.deps.agentlessRemote ?? isRemoteProjectPath)(target.projectPath)) return true;
        const cwds = new Set([target.projectPath]);
        if (target.folder) {
            for (const entry of await this.deps.transcripts.locations(target.folder, sessionId)) cwds.add(entry.cwd);
        }
        const roots = new Set<string>();
        for (const cwd of cwds) {
            const root = await this.deps.git.worktreeRoot(cwd);
            if (root) roots.add(root);
        }
        for (const root of roots) {
            if ((await this.deps.git.status(root)).length > 0) return true;
        }
        return false;
    }
}
