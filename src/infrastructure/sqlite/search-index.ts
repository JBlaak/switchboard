/**
 * FTS5 behind the SearchIndex port.
 *
 * An FTS5 table cannot hold columns it does not index, so each row's identity
 * lives in `search_map` beside it and the two are joined on rowid. Keeping them
 * in step is the whole subtlety here: `INSERT OR REPLACE` on the map allocates
 * a *new* rowid and leaves the old FTS row orphaned, which showed up as
 * duplicate results and an index that grew without bound. So an upsert deletes
 * both halves of any existing row first.
 */
import type Database from 'better-sqlite3';
import { ftsMatchExpression } from '../../domain/search/search';
import type { SearchEntry, SearchResult, SearchType } from '../../domain/search/search';
import type { SearchIndex } from '../../application/ports/search-index';

export class SqliteSearchIndex implements SearchIndex {
  readonly #sessionCount;
  readonly #lookup;
  readonly #insertMap;
  readonly #insertFts;
  readonly #deleteFtsByRowid;
  readonly #deleteMapByRowid;
  readonly #deleteFtsBySession;
  readonly #deleteMapBySession;
  readonly #deleteFtsByFolder;
  readonly #deleteMapByFolder;
  readonly #deleteFtsByType;
  readonly #deleteMapByType;
  readonly #updateTitle;
  readonly #query;

  readonly #upsertMany;
  readonly #recreated: boolean;

  constructor(db: Database.Database, searchFtsRecreated: boolean) {
    this.#recreated = searchFtsRecreated;

    this.#sessionCount = db.prepare<[SearchType], { cnt: number }>(
      'SELECT COUNT(*) as cnt FROM search_map WHERE type = ?');
    this.#lookup = db.prepare<[string, SearchType], { rowid: number }>(
      'SELECT rowid FROM search_map WHERE id = ? AND type = ?');
    this.#insertMap = db.prepare<[string, SearchType, string | null]>(
      'INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)');
    this.#insertFts = db.prepare<[number | bigint, string, string]>(
      'INSERT OR REPLACE INTO search_fts(rowid, title, body) VALUES (?, ?, ?)');
    this.#deleteFtsByRowid = db.prepare<[number]>('DELETE FROM search_fts WHERE rowid = ?');
    this.#deleteMapByRowid = db.prepare<[number]>('DELETE FROM search_map WHERE rowid = ?');
    this.#deleteFtsBySession = db.prepare<[string]>(
      "DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = 'session' AND id = ?)");
    this.#deleteMapBySession = db.prepare<[string]>(
      "DELETE FROM search_map WHERE type = 'session' AND id = ?");
    this.#deleteFtsByFolder = db.prepare<[string]>(
      "DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = 'session' AND folder = ?)");
    this.#deleteMapByFolder = db.prepare<[string]>(
      "DELETE FROM search_map WHERE type = 'session' AND folder = ?");
    this.#deleteFtsByType = db.prepare<[SearchType]>(
      'DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)');
    this.#deleteMapByType = db.prepare<[SearchType]>('DELETE FROM search_map WHERE type = ?');
    this.#updateTitle = db.prepare<[string, string, SearchType]>(
      'UPDATE search_fts SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)');
    this.#query = db.prepare<[SearchType, string, number], SearchResult>(`
      SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
      FROM search_fts
      JOIN search_map ON search_fts.rowid = search_map.rowid
      WHERE search_map.type = ? AND search_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this.#upsertMany = db.transaction((entries: readonly SearchEntry[]) => {
      for (const entry of entries) {
        const existing = this.#lookup.get(entry.id, entry.type);
        if (existing) {
          this.#deleteFtsByRowid.run(existing.rowid);
          this.#deleteMapByRowid.run(existing.rowid);
        }
        const inserted = this.#insertMap.run(entry.id, entry.type, entry.folder || null);
        this.#insertFts.run(inserted.lastInsertRowid, entry.title || '', entry.body || '');
      }
    });
  }

  isPopulated(): boolean {
    return (this.#sessionCount.get('session')?.cnt ?? 0) > 0;
  }

  wasRecreated(): boolean {
    return this.#recreated;
  }

  upsert(entries: readonly SearchEntry[]): void {
    this.#upsertMany(entries);
  }

  deleteSession(sessionId: string): void {
    this.#deleteFtsBySession.run(sessionId);
    this.#deleteMapBySession.run(sessionId);
  }

  deleteFolder(folder: string): void {
    this.#deleteFtsByFolder.run(folder);
    this.#deleteMapByFolder.run(folder);
  }

  deleteType(type: SearchType): void {
    this.#deleteFtsByType.run(type);
    this.#deleteMapByType.run(type);
  }

  updateTitle(id: string, type: SearchType, title: string): void {
    try {
      this.#updateTitle.run(title, id, type);
    } catch {
      // A rename of a session that is not indexed yet; the next index pass
      // writes the title anyway.
    }
  }

  query(type: SearchType, query: string, limit: number, titleOnly: boolean): SearchResult[] {
    try {
      return this.#query.all(type, ftsMatchExpression(query, titleOnly), limit);
    } catch {
      // FTS5 rejects some inputs outright (an unbalanced quote survives
      // escaping as a syntax error). No results beats an error dialog while
      // the user is still typing.
      return [];
    }
  }
}
