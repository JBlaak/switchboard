/**
 * Keeping the session cache in step with the transcripts on disk.
 *
 * Claude CLI writes transcripts; Switchboard reads them and keeps a cache so
 * the sidebar renders from one query instead of thousands of file parses. Three
 * paths keep that cache honest, in ascending order of cost:
 *
 *   refreshFolder      one folder, only the transcripts whose mtime moved
 *   reconcile          every folder whose newest write is newer than our gate
 *   rebuild            everything, on a worker, for a cold start
 *
 * The cheap ones are what make the app usable; the expensive one is what makes
 * it correct after being closed for a week.
 */
import { searchTitleFor, nameToPersist, titleSourcesFor } from '../../domain/session/title';
import type { SearchEntry } from '../../domain/search/search';
import type { Session } from '../../domain/session/session';
import type { Logger } from '../ports/logger';
import type { Timers } from '../ports/clock';
import type { ProjectScanner } from '../ports/project-scanner';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { SearchIndex } from '../ports/search-index';
import type { SessionRepository } from '../ports/session-repository';
import type { TranscriptStore } from '../ports/transcript-store';

export interface SessionIndexDeps {
  repository: SessionRepository;
  searchIndex: SearchIndex;
  transcripts: TranscriptStore;
  scanner: ProjectScanner;
  renderer: RendererGateway;
  timers: Timers;
  log: Logger;
}

/** How long a finished status message stays in the status bar. */
const STATUS_LINGER_MS = 5000;

export class SessionIndex {
  #rebuilding = false;

  constructor(private readonly deps: SessionIndexDeps) {}

  /** True when there is nothing usable to render from yet. */
  needsRebuild(): boolean {
    const { repository, searchIndex } = this.deps;
    return !repository.isCachePopulated() || !searchIndex.isPopulated();
  }

  /**
   * Re-read one folder, skipping every transcript whose file mtime is unchanged.
   *
   * All the writes are collected first and applied in a batch, to keep the
   * store's write lock held for as short a time as possible — this runs from a
   * filesystem watcher, so it can fire while the renderer is mid-query.
   */
  refreshFolder(folder: string): void {
    const { repository, searchIndex, transcripts } = this.deps;

    if (!transcripts.folderExists(folder)) {
      repository.deleteCachedFolder(folder);
      searchIndex.deleteFolder(folder);
      return;
    }

    const resolved = transcripts.resolveProjectPath(folder);
    if (!resolved) {
      // Nothing readable in it, but record the visit so the gate does not keep
      // re-reading an empty or unparseable folder on every reconcile.
      repository.setFolderMeta(folder, null, null, transcripts.folderIndexMtimeMs(folder));
      return;
    }
    const { projectPath, cwd } = resolved;

    const cachedMtimes = new Map<string, string>();
    for (const row of repository.getCachedFingerprints(folder)) {
      cachedMtimes.set(row.sessionId, row.fileMtime);
    }

    const sessionsToUpsert: Session[] = [];
    const searchEntries: SearchEntry[] = [];
    const namesToPersist: { sessionId: string; name: string }[] = [];
    const currentIds = new Set<string>();

    for (const sessionId of transcripts.listSessionIds(folder)) {
      currentIds.add(sessionId);
      const fingerprint = transcripts.sessionFingerprint(folder, sessionId);
      if (fingerprint === null) continue;
      if (cachedMtimes.get(sessionId) === fingerprint) continue;

      const session = transcripts.readSession(folder, sessionId, projectPath);
      if (!session) continue;

      sessionsToUpsert.push(session);
      const sources = titleSourcesFor(session, repository.getMeta(session.sessionId));
      searchEntries.push({
        id: session.sessionId,
        type: 'session',
        folder: session.folder,
        title: searchTitleFor(sources, session.summary),
        body: session.textContent,
      });
      const name = nameToPersist(session);
      if (name) namesToPersist.push({ sessionId: session.sessionId, name });
    }

    const removed = [...cachedMtimes.keys()].filter(id => !currentIds.has(id));

    if (sessionsToUpsert.length) repository.upsertCachedSessions(sessionsToUpsert);
    for (const entry of searchEntries) searchIndex.deleteSession(entry.id);
    if (searchEntries.length) searchIndex.upsert(searchEntries);
    for (const { sessionId, name } of namesToPersist) repository.setName(sessionId, name);
    for (const sessionId of removed) {
      repository.deleteCachedSession(sessionId);
      searchIndex.deleteSession(sessionId);
    }

    repository.setFolderMeta(folder, projectPath, cwd, transcripts.folderIndexMtimeMs(folder));
  }

  /**
   * Re-index folders that are new, or whose newest transcript is newer than
   * what we last indexed.
   *
   * Stat-only when nothing has changed, which is what lets it run on every
   * project list. This is what keeps sessions from silently going missing: a
   * folder that changed while the app was closed, or that predates the build
   * which first indexed it, is otherwise never picked up — the cold-start
   * rebuild only runs when the cache is completely empty.
   */
  reconcile(): void {
    const { repository, transcripts, log } = this.deps;
    try {
      const meta = repository.getAllFolderMeta();
      for (const folder of transcripts.listFolders()) {
        const known = meta.get(folder);
        if (!known || transcripts.folderIndexMtimeMs(folder) > (known.indexMtimeMs || 0)) {
          this.refreshFolder(folder);
        }
      }
    } catch (err) {
      log.error('[index] reconcile failed:', (err as Error).message);
    }
  }

  /** Forget a folder entirely — the user removed the project. */
  forgetFolder(folder: string): void {
    this.deps.repository.deleteCachedFolder(folder);
    this.deps.searchIndex.deleteFolder(folder);
  }

  /**
   * Rebuild the whole cache from disk, off the main thread.
   *
   * Fire-and-forget: it reports progress through the status bar and refreshes
   * the sidebar when it lands. Re-entrant calls are dropped rather than queued —
   * a second full scan would only produce the same answer.
   */
  rebuild(): void {
    if (this.#rebuilding) return;
    this.#rebuilding = true;
    this.#status('Scanning projects…', 'active');

    void this.#runRebuild()
      .catch((err: Error) => {
        this.deps.log.error('[index] rebuild failed:', err.message);
        this.#status('Scan failed: ' + err.message, 'error');
      })
      .finally(() => {
        this.#rebuilding = false;
      });
  }

  async #runRebuild(): Promise<void> {
    const { repository, searchIndex, scanner, renderer } = this.deps;

    const results = await scanner.scan(text => this.#status(text, 'active'));
    this.#status(`Indexing ${results.length} projects…`, 'active');

    let sessionCount = 0;
    for (const { folder, projectPath, cwd, sessions, indexMtimeMs } of results) {
      repository.deleteCachedFolder(folder);
      searchIndex.deleteFolder(folder);
      if (sessions.length) {
        sessionCount += sessions.length;
        repository.upsertCachedSessions(sessions);
        for (const session of sessions) {
          const name = nameToPersist(session);
          if (name) repository.setName(session.sessionId, name);
        }
        searchIndex.upsert(sessions.map(session => ({
          id: session.sessionId,
          type: 'session' as const,
          folder: session.folder,
          title: searchTitleFor(titleSourcesFor(session, repository.getMeta(session.sessionId)), session.summary),
          body: session.textContent,
        })));
      }
      repository.setFolderMeta(folder, projectPath, cwd, indexMtimeMs);
    }

    this.#status(`Indexed ${sessionCount} sessions across ${results.length} projects`, 'done');
    this.deps.timers.setTimeout(() => this.#status(''), STATUS_LINGER_MS);
    renderer.projectsChanged();
  }

  #status(text: string, type = 'info'): void {
    if (text) this.deps.log.info(`[status] (${type}) ${text}`);
    this.deps.renderer.statusUpdate(text, type);
  }
}
