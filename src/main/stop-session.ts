/**
 * Stopping a session, for the renderer's Stop and archive, and a phone's
 * archive, which does here what the renderer's archive does there.
 */
import type { RendererGateway } from '../application/ports/renderer-gateway';
import type { SessionRepository } from '../application/ports/session-repository';
import type { WorktreeCleanupService } from '../application/services/worktree-cleanup-service';
import type { TasksService } from '../application/services/tasks-service';
import type { Container } from './composition-root';

export type SessionStopper = Pick<Container, 'registry' | 'remote' | 'lifecycle' | 'terminals'>;

export interface StopResult {
  ok: boolean;
  alreadyStopped?: boolean;
}

/**
 * Stop a session.
 *
 * `ok` means nothing is running under that id any more — either it never was,
 * or it has been retired, or a kill is on its way that will retire it.
 * Callers that hide a row (archive) can rely on that; `ok: false` means the
 * record is still live and the row should stay.
 */
export function stopSession(app: SessionStopper, sessionId: string): StopResult {
  const found = app.registry.find(sessionId);
  if (!found) return { ok: true, alreadyStopped: true };
  const { key, session } = found;

  // Remote sessions: stop reconnecting first, or killing the PTY (or the
  // retry already on a timer) would just dial straight back out.
  if (session.remote) {
    const wasWaiting = session.exited;
    app.remote.markDisconnected(session);
    if (wasWaiting) {
      // Nothing to kill — the connection is already down and only the backoff
      // was keeping the session alive. Retire it the way an exit would.
      app.remote.sendStatus(key, { phase: 'disconnected', target: session.remote.target });
      app.lifecycle.retire(key, session, 0);
      return { ok: true, alreadyStopped: true };
    }
  }

  // Dead process, live record: the exit event never landed. Nothing to
  // signal, but the record still has to go or the row stays on "Running".
  if (session.exited || !app.terminals.isAlive(session.pty)) {
    app.lifecycle.retire(key, session, 0);
    return { ok: true, alreadyStopped: true };
  }

  app.lifecycle.stop(key, session);
  return { ok: true };
}

/**
 * A phone's archive, as the renderer's (`archiveSessionRow`): stopped first,
 * then the row archived, then the window told, so it closes the session as
 * archiving it there would. Its worktrees are cleaned up after, on their own,
 * and its task (#248) gets its "Session archived" line. Neither a phone's
 * archive nor a session's own (`archive_session`) offers Mark done: that is
 * asked only of an archive made at the Mac.
 */
export function sessionArchiver(app: SessionStopper & {
  repository: Pick<SessionRepository, 'setArchived'>;
  renderer: Pick<RendererGateway, 'sessionArchived'>;
  worktreeCleanup: Pick<WorktreeCleanupService, 'afterArchive'>;
  tasks?: Pick<TasksService, 'archived'>;
}): { archive(sessionId: string): { ok: boolean } } {
  return {
    archive(sessionId) {
      const stopped = stopSession(app, sessionId);
      if (!stopped.ok) return { ok: false };
      app.repository.setArchived(sessionId, true);
      app.renderer.sessionArchived(sessionId);
      void app.worktreeCleanup.afterArchive(sessionId);
      void app.tasks?.archived(sessionId, { byUser: false });
      return { ok: true };
    },
  };
}
