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
import {ftsMatchExpression} from '../../domain/search/search';
import type {SearchEntry, SearchResult, SearchType} from '../../domain/search/search';
import type {SearchIndex} from '../../application/ports/search-index';

/**
 * One type's matches, best ranked first, each with an excerpt of its body
 * (column 1): the hits wrapped in <mark> for the renderer to highlight, cut to
 * about 40 tokens around them.
 */
const QUERY_SQL = `
    SELECT entry.id AS id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) AS snippet
    FROM search_fts
    INNER JOIN search_map AS entry ON entry.rowid = search_fts.rowid
    WHERE entry.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?`;

export class SqliteSearchIndex implements SearchIndex {
    private readonly sessionCountStatement;
    private readonly lookupStatement;
    private readonly insertMapStatement;
    private readonly insertFtsStatement;
    private readonly deleteFtsByRowidStatement;
    private readonly deleteMapByRowidStatement;
    private readonly deleteFtsBySessionStatement;
    private readonly deleteMapBySessionStatement;
    private readonly deleteFtsByFolderStatement;
    private readonly deleteMapByFolderStatement;
    private readonly updateTitleStatement;
    private readonly queryStatement;

    private readonly upsertManyTransaction;
    private readonly recreated: boolean;

    constructor(db: Database.Database, searchFtsRecreated: boolean) {
        this.recreated = searchFtsRecreated;

        this.sessionCountStatement = db.prepare<[SearchType], {cnt: number}>(
            'SELECT COUNT(*) as cnt FROM search_map WHERE type = ?',
        );
        this.lookupStatement = db.prepare<[string, SearchType], {rowid: number}>(
            'SELECT rowid FROM search_map WHERE id = ? AND type = ?',
        );
        this.insertMapStatement = db.prepare<[string, SearchType, string | null]>(
            'INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)',
        );
        this.insertFtsStatement = db.prepare<[number | bigint, string, string]>(
            'INSERT OR REPLACE INTO search_fts(rowid, title, body) VALUES (?, ?, ?)',
        );
        this.deleteFtsByRowidStatement = db.prepare<[number]>('DELETE FROM search_fts WHERE rowid = ?');
        this.deleteMapByRowidStatement = db.prepare<[number]>('DELETE FROM search_map WHERE rowid = ?');
        this.deleteFtsBySessionStatement = db.prepare<[string]>(
            "DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = 'session' AND id = ?)",
        );
        this.deleteMapBySessionStatement = db.prepare<[string]>(
            "DELETE FROM search_map WHERE type = 'session' AND id = ?",
        );
        this.deleteFtsByFolderStatement = db.prepare<[string]>(
            "DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = 'session' AND folder = ?)",
        );
        this.deleteMapByFolderStatement = db.prepare<[string]>(
            "DELETE FROM search_map WHERE type = 'session' AND folder = ?",
        );
        this.updateTitleStatement = db.prepare<[string, string, SearchType]>(
            'UPDATE search_fts SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)',
        );
        this.queryStatement = db.prepare<[SearchType, string, number], SearchResult>(QUERY_SQL);

        this.upsertManyTransaction = db.transaction((entries: readonly SearchEntry[]) => {
            for (const entry of entries) {
                const existing = this.lookupStatement.get(entry.id, entry.type);
                if (existing) {
                    this.deleteFtsByRowidStatement.run(existing.rowid);
                    this.deleteMapByRowidStatement.run(existing.rowid);
                }
                const inserted = this.insertMapStatement.run(entry.id, entry.type, entry.folder || null);
                this.insertFtsStatement.run(inserted.lastInsertRowid, entry.title || '', entry.body || '');
            }
        });
    }

    public isPopulated(): boolean {
        return (this.sessionCountStatement.get('session')?.cnt ?? 0) > 0;
    }

    public wasRecreated(): boolean {
        return this.recreated;
    }

    public upsert(entries: readonly SearchEntry[]): void {
        this.upsertManyTransaction(entries);
    }

    public deleteSession(sessionId: string): void {
        this.deleteFtsBySessionStatement.run(sessionId);
        this.deleteMapBySessionStatement.run(sessionId);
    }

    public deleteFolder(folder: string): void {
        this.deleteFtsByFolderStatement.run(folder);
        this.deleteMapByFolderStatement.run(folder);
    }

    public updateTitle(id: string, type: SearchType, title: string): void {
        try {
            this.updateTitleStatement.run(title, id, type);
        } catch {
            // A rename of a session that is not indexed yet; the next index pass
            // writes the title anyway.
        }
    }

    public query(type: SearchType, query: string, limit: number, titleOnly: boolean): SearchResult[] {
        try {
            return this.queryStatement.all(type, ftsMatchExpression(query, titleOnly), limit);
        } catch {
            // FTS5 rejects some inputs outright (an unbalanced quote survives
            // escaping as a syntax error). No results beats an error dialog while
            // the user is still typing.
            return [];
        }
    }
}
