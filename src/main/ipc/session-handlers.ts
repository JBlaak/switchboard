/**
 * Session state: which are running, stopping one, and the per-session metadata.
 */
import { INVOKE } from '../../ipc/channels';
import { searchTitleFor } from '../../domain/session/title';
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

  /**
   * Stop a session.
   *
   * `ok` means nothing is running under that id any more — either it never was,
   * or it has been retired, or a kill is on its way that will retire it.
   * Callers that hide a row (archive) can rely on that; `ok: false` means the
   * record is still live and the row should stay.
   */
  ipc.handle(INVOKE.stopSession, (sessionId: string) => {
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
  });

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

  ipc.handle(INVOKE.archiveSession, (sessionId: string, archived: boolean) => {
    app.repository.setArchived(sessionId, archived);
    return { archived: archived ? 1 : 0 };
  });

  /** A session's whole transcript, for the message-history viewer. */
  ipc.handle(INVOKE.readSessionJsonl, (sessionId: string) => {
    const folder = app.repository.getCachedFolder(sessionId);
    if (!folder) return { error: 'Session not found in cache' };
    try {
      return { entries: app.transcripts.readEntries(folder, sessionId) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
}
