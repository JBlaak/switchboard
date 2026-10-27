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
 * that refuses is logged, and the archive stands either way. Remote sessions
 * are left alone; their worktrees are on another machine.
 */
import { isRemoteProjectPath } from '../../domain/project/remote-target';
import { worktreeVerdicts } from '../../domain/session-work/worktree-cleanup';
import type { GitWorkspace, GitWorktrees } from '../ports/git-workspace';
import type { Logger } from '../ports/logger';
import type { TranscriptStore } from '../ports/transcript-store';
import type { SessionWorkTarget } from './session-work-service';

export interface WorktreeCleanupDeps {
  /** The global setting, read at each archive. */
  enabled(): boolean;
  /** Where a session lives, or null when no session goes by that id. */
  locate(sessionId: string): SessionWorkTarget | null;
  transcripts: Pick<TranscriptStore, 'locations'>;
  git: Pick<GitWorkspace, 'worktreeRoot' | 'worktrees'> & Pick<GitWorktrees, 'mainCheckout' | 'removeWorktree'>;
  /** The directories every session but this one works in: running, or listed and not archived. */
  otherSessionPaths(sessionId: string): string[];
  log: Logger;
}

export class WorktreeCleanupService {
  constructor(private readonly deps: WorktreeCleanupDeps) {}

  /** Remove what `sessionId`, just archived, leaves behind; never throws. */
  async afterArchive(sessionId: string): Promise<void> {
    if (!this.deps.enabled()) return;
    try {
      await this.#clean(sessionId);
    } catch (err) {
      this.deps.log.warn(`[worktree-cleanup] ${sessionId}: ${(err as Error).message}`);
    }
  }

  async #clean(sessionId: string): Promise<void> {
    const target = this.deps.locate(sessionId);
    if (!target || isRemoteProjectPath(target.projectPath)) return;

    const cwds = [target.projectPath];
    if (target.folder) cwds.push(...this.deps.transcripts.locations(target.folder, sessionId).map((entry) => entry.cwd));

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

    const inUse = this.deps.otherSessionPaths(sessionId);
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
        this.deps.log.info(`[worktree-cleanup] ${sessionId}: ${removed.ok
          ? `removed ${verdict.path}`
          : `could not remove ${verdict.path}: ${removed.reason}`}`);
      }
    }
  }
}
