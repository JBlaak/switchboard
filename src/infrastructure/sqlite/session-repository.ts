/**
 * SQLite behind the SessionRepository port.
 *
 * Statements are prepared once in the constructor, which is what makes the
 * sidebar's per-render queries free; the two bulk writes are wrapped in
 * transactions, because indexing a project means hundreds of upserts and a
 * transaction each would take a second.
 */
import type Database from 'better-sqlite3';
import type { CachedSession, FolderMeta, SessionMeta } from '../../domain/session/session';
import type { SessionRepository } from '../../application/ports/session-repository';

export class SqliteSessionRepository implements SessionRepository {
  readonly #metaGet;
  readonly #metaGetAll;
  readonly #metaUpsertName;
  readonly #metaToggleStar;
  readonly #metaUpsertArchived;

  readonly #cacheCount;
  readonly #cacheGetAll;
  readonly #cacheGetOne;
  readonly #cacheGetFolder;
  readonly #cacheGetFingerprints;
  readonly #cacheUpsert;
  readonly #cacheDeleteOne;
  readonly #cacheDeleteFolder;

  readonly #folderGetAll;
  readonly #folderUpsert;
  readonly #folderDelete;

  readonly #upsertMany;

  constructor(db: Database.Database) {
    this.#metaGet = db.prepare<[string], SessionMeta>(
      'SELECT * FROM session_meta WHERE sessionId = ?');
    this.#metaGetAll = db.prepare<[], SessionMeta>('SELECT * FROM session_meta');
    this.#metaUpsertName = db.prepare<[string, string | null]>(`
      INSERT INTO session_meta (sessionId, name) VALUES (?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name
    `);
    this.#metaToggleStar = db.prepare<[string]>(`
      INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
      ON CONFLICT(sessionId) DO UPDATE SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END
    `);
    this.#metaUpsertArchived = db.prepare<[string, 0 | 1]>(`
      INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
    `);

    this.#cacheCount = db.prepare<[], { cnt: number }>('SELECT COUNT(*) as cnt FROM session_cache');
    this.#cacheGetAll = db.prepare<[], CachedSession>('SELECT * FROM session_cache');
    this.#cacheGetOne = db.prepare<[string], CachedSession>(
      'SELECT * FROM session_cache WHERE sessionId = ?');
    this.#cacheGetFolder = db.prepare<[string], { folder: string }>(
      'SELECT folder FROM session_cache WHERE sessionId = ?');
    this.#cacheGetFingerprints = db.prepare<[string], Pick<CachedSession, 'sessionId' | 'fileMtime'>>(
      'SELECT sessionId, fileMtime FROM session_cache WHERE folder = ?');
    this.#cacheUpsert = db.prepare<[
      string, string, string, string, string, string, string, number,
      string | null, string | null, string | null,
    ]>(`
      INSERT INTO session_cache (
        sessionId, folder, projectPath, summary, firstPrompt, created, modified,
        messageCount, slug, aiTitle, fileMtime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        folder = excluded.folder, projectPath = excluded.projectPath,
        summary = excluded.summary, firstPrompt = excluded.firstPrompt,
        created = excluded.created, modified = excluded.modified,
        messageCount = excluded.messageCount, slug = excluded.slug,
        aiTitle = excluded.aiTitle, fileMtime = excluded.fileMtime
    `);
    this.#cacheDeleteOne = db.prepare<[string]>('DELETE FROM session_cache WHERE sessionId = ?');
    this.#cacheDeleteFolder = db.prepare<[string]>('DELETE FROM session_cache WHERE folder = ?');

    this.#folderGetAll = db.prepare<[], FolderMeta>('SELECT * FROM cache_meta');
    this.#folderUpsert = db.prepare<[string, string | null, number]>(`
      INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)
      ON CONFLICT(folder) DO UPDATE SET
        projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
    `);
    this.#folderDelete = db.prepare<[string]>('DELETE FROM cache_meta WHERE folder = ?');

    this.#upsertMany = db.transaction((sessions: readonly CachedSession[]) => {
      for (const s of sessions) {
        this.#cacheUpsert.run(
          s.sessionId, s.folder, s.projectPath, s.summary, s.firstPrompt,
          s.created, s.modified, s.messageCount || 0,
          s.slug || null, s.aiTitle || null, s.fileMtime || null);
      }
    });
  }

  // ── Metadata ──

  getMeta(sessionId: string): SessionMeta | null {
    return this.#metaGet.get(sessionId) ?? null;
  }

  getAllMeta(): Map<string, SessionMeta> {
    const map = new Map<string, SessionMeta>();
    for (const row of this.#metaGetAll.all()) map.set(row.sessionId, row);
    return map;
  }

  setName(sessionId: string, name: string | null): void {
    this.#metaUpsertName.run(sessionId, name);
  }

  toggleStar(sessionId: string): 0 | 1 {
    this.#metaToggleStar.run(sessionId);
    return this.#metaGet.get(sessionId)?.starred ?? 0;
  }

  setArchived(sessionId: string, archived: boolean): void {
    this.#metaUpsertArchived.run(sessionId, archived ? 1 : 0);
  }

  // ── Cache ──

  isCachePopulated(): boolean {
    return (this.#cacheCount.get()?.cnt ?? 0) > 0;
  }

  getAllCached(): CachedSession[] {
    return this.#cacheGetAll.all();
  }

  getCachedSession(sessionId: string): CachedSession | null {
    return this.#cacheGetOne.get(sessionId) ?? null;
  }

  getCachedFolder(sessionId: string): string | null {
    return this.#cacheGetFolder.get(sessionId)?.folder ?? null;
  }

  getCachedFingerprints(folder: string): Pick<CachedSession, 'sessionId' | 'fileMtime'>[] {
    return this.#cacheGetFingerprints.all(folder);
  }

  upsertCachedSessions(sessions: readonly CachedSession[]): void {
    this.#upsertMany(sessions);
  }

  deleteCachedSession(sessionId: string): void {
    this.#cacheDeleteOne.run(sessionId);
  }

  deleteCachedFolder(folder: string): void {
    this.#cacheDeleteFolder.run(folder);
    this.#folderDelete.run(folder);
  }

  // ── Folder index gate ──

  getAllFolderMeta(): Map<string, FolderMeta> {
    const map = new Map<string, FolderMeta>();
    for (const row of this.#folderGetAll.all()) map.set(row.folder, row);
    return map;
  }

  setFolderMeta(folder: string, projectPath: string | null, indexMtimeMs: number): void {
    this.#folderUpsert.run(folder, projectPath, indexMtimeMs);
  }
}
