/**
 * Session state: which are running, stopping one, and the per-session metadata.
 */
import { INVOKE } from '../../ipc/channels';
import { searchTitleFor } from '../../domain/session/title';
import { stopSession } from '../stop-session';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerSessionHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.getActiveSessions, () => app.lifecycle.runningSessionIds());

  /** The plain terminals, so a reloaded renderer can restore them. */
  ipc.handle(INVOKE.getActiveTerminals, () => {
    const terminals: { sessionId: string; projectPath: string }[] = [];
    for (const [sessionId, session] of app.registry.snapshot()) {
      if (session.exited || !session.isPlainTerminal) continue;
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
    return terminals;
  });

  ipc.handle(INVOKE.stopSession, (sessionId: string) => stopSession(app, sessionId));

  /**
   * "Retry now" on a connecting card: skip the rest of the backoff.
   *
   * Safe at any time — it no-ops unless the session is remote, still held, and
   * actually between connections.
   */
  ipc.handle(INVOKE.reconnectRemote, (sessionId: string) => app.remote.retryNow(sessionId));

  ipc.handle(INVOKE.toggleStar, (sessionId: string) => ({
    starred: app.repository.toggleStar(sessionId),
  }));

  /**
   * Rename a session.
   *
   * The search index carries the name as part of its title, so a rename has to
   * update it or the session stops being findable under its new name until the
   * next re-index.
   */
  ipc.handle(INVOKE.renameSession, (sessionId: string, name: string | null) => {
    app.repository.setName(sessionId, name || null);
    const summary = app.repository.getCachedSession(sessionId)?.summary || '';
    app.searchIndex.updateTitle(sessionId, 'session', searchTitleFor({ storedName: name }, summary));
    return { name: name || null };
  });

  // The window has closed it already; a phone with it open closes it too, and
  // its worktrees go after, when Settings says so. Its task (#248) gets a line,
  // and when every PR the session opened is merged the answer offers Mark done:
  // archived here, it was archived by you.
  ipc.handle(INVOKE.archiveSession, async (sessionId: string, archived: boolean) => {
    app.repository.setArchived(sessionId, archived);
    if (!archived) return { archived: 0 };
    app.phoneSessions.sessionArchived(sessionId);
    void app.worktreeCleanup.afterArchive(sessionId);
    const markDone = await app.tasks.archived(sessionId, { byUser: true });
    return markDone ? { archived: 1, markDone } : { archived: 1 };
  });

  ipc.handle(INVOKE.snoozeSession, (sessionId: string, until: string | null) => {
    app.repository.setSnoozedUntil(sessionId, until);
  });
}
