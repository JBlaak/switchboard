import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type {
  CachedSession, FolderMeta, SearchEntry, SearchResult, SearchType, SessionMeta,
} from '../shared/types.js';

// SWITCHBOARD_DATA_DIR overrides the data dir so a dev/test instance can run
// alongside the installed app without sharing its DB (main.ts also isolates
// Electron userData / the single-instance lock off the same variable).
const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR)
  : path.join(os.homedir(), '.switchboard');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

// Migrate from old locations if needed — never when running against an
// override dir, so a dev instance can't relocate the real app's legacy DB.
const OLD_LOCATIONS = process.env.SWITCHBOARD_DATA_DIR ? [] : [
  path.join(os.homedir(), '.claude', 'browser', 'switchboard.db'),
  path.join(os.homedir(), '.claude', 'browser', 'session-browser.db'),
  path.join(os.homedir(), '.claude', 'session-browser.db'),
];
if (!fs.existsSync(DB_PATH)) {
  for (const oldPath of OLD_LOCATIONS) {
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, DB_PATH);
      try { fs.renameSync(oldPath + '-wal', DB_PATH + '-wal'); } catch {}
      try { fs.renameSync(oldPath + '-shm', DB_PATH + '-shm'); } catch {}
      break;
    }
  }
}
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS session_meta (
    sessionId TEXT PRIMARY KEY,
    name TEXT,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS session_cache (
    sessionId TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    projectPath TEXT,
    summary TEXT,
    firstPrompt TEXT,
    created TEXT,
    modified TEXT,
    messageCount INTEGER DEFAULT 0,
    slug TEXT,
    aiTitle TEXT,
    fileMtime TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_meta (
    folder TEXT PRIMARY KEY,
    projectPath TEXT,
    indexMtimeMs REAL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Index for fast folder lookups
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_folder ON session_cache(folder)');
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_slug ON session_cache(slug)');

// --- Migrations ---
// Each migration runs once, in order. Add new migrations to the end.
let searchFtsRecreatedFlag = false;
type Migration = (db: Database.Database) => void;
const migrations: Migration[] = [
  // v1: (superseded by v2)
  () => {},
  // v2: Clear session cache to re-index with corrected worktree paths
  (db) => {
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    searchFtsRecreatedFlag = true;
  },
  // v3: Add aiTitle column for AI-generated session titles. Clear cache so a
  // re-index repopulates the column. Also clear session_meta.name entries that
  // were clobbered by AI titles in v0.0.29 (when ai-title was written into the
  // user-name column). We cannot tell with certainty which names came from an
  // AI title vs a manual rename, but the safe heuristic is: drop names whose
  // value matches the JSONL aiTitle on next index. That post-index cleanup is
  // not done here — instead we accept that any pre-fix AI-title pollution
  // remains until the user renames manually, and only future indexes are clean.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v4: (superseded — fileMtime is added by the schema reconciliation below,
  // keyed on column presence rather than version number)
  () => {},
];

const currentDbVersion = ((): number => {
  try {
    const row = db.prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'db_version'").get();
    return row ? (JSON.parse(row.value) as number) : 0;
  } catch { return 0; }
})();

for (let i = currentDbVersion; i < migrations.length; i++) {
  migrations[i](db);
}
if (migrations.length > currentDbVersion) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(migrations.length));
}

// --- Schema reconciliation ---
// Version-numbered migrations cannot be trusted to add columns: a DB already
// migrated to a HIGHER version by a build from a parallel branch skips this
// branch's migrations entirely (a db_version-5 DB from the subagent branch
// never ran our v4, so the fileMtime ALTER never happened and every prepare()
// below crashed the app at startup). Required columns are therefore ensured by
// inspecting the actual schema, independent of db_version. Errors here are
// deliberately NOT swallowed: a transient failure (e.g. SQLITE_BUSY) must not
// be recorded as migrated — the next launch simply retries.
{
  const cols = new Set(
    db.prepare<[], { name: string }>('PRAGMA table_info(session_cache)').all().map(c => c.name)
  );
  if (!cols.has('aiTitle')) db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT');
  if (!cols.has('fileMtime')) {
    db.exec('ALTER TABLE session_cache ADD COLUMN fileMtime TEXT');
    // fileMtime's introduction changed what `modified` means (file mtime →
    // last-message timestamp), so cached values written by pre-fileMtime code
    // are stale. Clear the cache to force a full re-index; without this,
    // dormant folders would keep mtime-based times indefinitely because the
    // folder-level index gate never re-reads them.
    db.exec('DELETE FROM session_cache');
    db.exec('DELETE FROM cache_meta');
  }
}

// --- FTS5 full-text search ---
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body, tokenize='trigram case_sensitive 0'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS search_map (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    folder TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)');

const stmts = {
  get: db.prepare<[string], SessionMeta>('SELECT * FROM session_meta WHERE sessionId = ?'),
  getAll: db.prepare<[], SessionMeta>('SELECT * FROM session_meta'),
  upsertName: db.prepare<[string, string | null]>(`
    INSERT INTO session_meta (sessionId, name) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name
  `),
  upsertStar: db.prepare<[string]>(`
    INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
    ON CONFLICT(sessionId) DO UPDATE SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END
  `),
  upsertArchived: db.prepare<[string, 0 | 1]>(`
    INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
  `),
  // Session cache statements
  cacheCount: db.prepare<[], { cnt: number }>('SELECT COUNT(*) as cnt FROM session_cache'),
  cacheGetAll: db.prepare<[], CachedSession>('SELECT * FROM session_cache'),
  cacheUpsert: db.prepare<[
    string, string, string, string, string, string, string, number,
    string | null, string | null, string | null,
  ]>(`
    INSERT INTO session_cache (sessionId, folder, projectPath, summary, firstPrompt, created, modified, messageCount, slug, aiTitle, fileMtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      folder = excluded.folder, projectPath = excluded.projectPath,
      summary = excluded.summary, firstPrompt = excluded.firstPrompt,
      created = excluded.created, modified = excluded.modified,
      messageCount = excluded.messageCount, slug = excluded.slug,
      aiTitle = excluded.aiTitle, fileMtime = excluded.fileMtime
  `),
  cacheGetByFolder: db.prepare<[string], Pick<CachedSession, 'sessionId' | 'fileMtime'>>('SELECT sessionId, fileMtime FROM session_cache WHERE folder = ?'),
  cacheGetFolder: db.prepare<[string], { folder: string }>('SELECT folder FROM session_cache WHERE sessionId = ?'),
  cacheGetSession: db.prepare<[string], CachedSession>('SELECT * FROM session_cache WHERE sessionId = ?'),
  cacheDeleteSession: db.prepare<[string]>('DELETE FROM session_cache WHERE sessionId = ?'),
  cacheDeleteFolder: db.prepare<[string]>('DELETE FROM session_cache WHERE folder = ?'),
  // Cache meta statements
  metaGet: db.prepare<[string], FolderMeta>('SELECT * FROM cache_meta WHERE folder = ?'),
  metaGetAll: db.prepare<[], FolderMeta>('SELECT * FROM cache_meta'),
  metaUpsert: db.prepare<[string, string | null, number]>(`
    INSERT INTO cache_meta (folder, projectPath, indexMtimeMs)
    VALUES (?, ?, ?)
    ON CONFLICT(folder) DO UPDATE SET
      projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
  `),
  metaDelete: db.prepare<[string]>('DELETE FROM cache_meta WHERE folder = ?'),
  // FTS search statements
  searchDeleteBySession: db.prepare<[string]>('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchMapDeleteBySession: db.prepare<[string]>('DELETE FROM search_map WHERE type = \'session\' AND id = ?'),
  searchDeleteByFolder: db.prepare<[string]>('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchMapDeleteByFolder: db.prepare<[string]>('DELETE FROM search_map WHERE type = \'session\' AND folder = ?'),
  searchDeleteByType: db.prepare<[SearchType]>('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchMapDeleteByType: db.prepare<[SearchType]>('DELETE FROM search_map WHERE type = ?'),
  searchInsertFts: db.prepare<[number | bigint, string, string]>('INSERT OR REPLACE INTO search_fts(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertMap: db.prepare<[string, SearchType, string | null]>('INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)'),
  searchMapLookup: db.prepare<[string, SearchType], { rowid: number }>('SELECT rowid FROM search_map WHERE id = ? AND type = ?'),
  searchUpdateTitle: db.prepare<[string, string, SearchType]>('UPDATE search_fts SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)'),
  searchDeleteByRowid: db.prepare<[number]>('DELETE FROM search_fts WHERE rowid = ?'),
  searchMapDeleteByRowid: db.prepare<[number]>('DELETE FROM search_map WHERE rowid = ?'),
  // Settings statements
  settingsGet: db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?'),
  settingsUpsert: db.prepare<[string, string]>(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  settingsDelete: db.prepare<[string]>('DELETE FROM settings WHERE key = ?'),
  searchQuery: db.prepare<[SearchType, string, number], SearchResult>(`
    SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
};

/** True when a migration dropped and recreated the FTS table, so it needs refilling. */
export const searchFtsRecreated = searchFtsRecreatedFlag;

export function getMeta(sessionId: string): SessionMeta | null {
  return stmts.get.get(sessionId) ?? null;
}

export function getAllMeta(): Map<string, SessionMeta> {
  const rows = stmts.getAll.all();
  const map = new Map<string, SessionMeta>();
  for (const row of rows) map.set(row.sessionId, row);
  return map;
}

export function setName(sessionId: string, name: string | null): void {
  stmts.upsertName.run(sessionId, name);
}

export function toggleStar(sessionId: string): 0 | 1 {
  stmts.upsertStar.run(sessionId);
  const row = stmts.get.get(sessionId);
  return row ? row.starred : 0;
}

export function setArchived(sessionId: string, archived: boolean): void {
  stmts.upsertArchived.run(sessionId, archived ? 1 : 0);
}

// --- Session cache functions ---

export function isCachePopulated(): boolean {
  const row = stmts.cacheCount.get();
  return (row?.cnt ?? 0) > 0;
}

export function getAllCached(): CachedSession[] {
  return stmts.cacheGetAll.all();
}

const upsertCachedSessionsBatch = db.transaction((sessions: CachedSession[]) => {
  for (const s of sessions) {
    stmts.cacheUpsert.run(
      s.sessionId, s.folder, s.projectPath, s.summary,
      s.firstPrompt, s.created, s.modified, s.messageCount || 0,
      s.slug || null, s.aiTitle || null, s.fileMtime || null
    );
  }
});

export function upsertCachedSessions(sessions: CachedSession[]): void {
  upsertCachedSessionsBatch(sessions);
}

export function getCachedByFolder(folder: string): Pick<CachedSession, 'sessionId' | 'fileMtime'>[] {
  return stmts.cacheGetByFolder.all(folder);
}

export function getCachedFolder(sessionId: string): string | null {
  const row = stmts.cacheGetFolder.get(sessionId);
  return row ? row.folder : null;
}

export function getCachedSession(sessionId: string): CachedSession | null {
  return stmts.cacheGetSession.get(sessionId) ?? null;
}

export function deleteCachedSession(sessionId: string): void {
  stmts.cacheDeleteSession.run(sessionId);
}

export function deleteCachedFolder(folder: string): void {
  stmts.cacheDeleteFolder.run(folder);
  stmts.metaDelete.run(folder);
}

export function getFolderMeta(folder: string): FolderMeta | null {
  return stmts.metaGet.get(folder) ?? null;
}

export function getAllFolderMeta(): Map<string, FolderMeta> {
  const rows = stmts.metaGetAll.all();
  const map = new Map<string, FolderMeta>();
  for (const row of rows) map.set(row.folder, row);
  return map;
}

export function setFolderMeta(folder: string, projectPath: string | null, indexMtimeMs: number): void {
  stmts.metaUpsert.run(folder, projectPath, indexMtimeMs);
}

// --- FTS search functions ---

const upsertSearchEntriesBatch = db.transaction((entries: SearchEntry[]) => {
  for (const e of entries) {
    // Delete any existing FTS row for this (id, type) pair before inserting.
    // search_map uses INSERT OR REPLACE which deletes the old row and creates
    // a new one with a new rowid, but the orphaned FTS5 row keyed to the old
    // rowid would never be cleaned up — causing duplicate search results and
    // unbounded FTS table growth.
    const existing = stmts.searchMapLookup.get(e.id, e.type);
    if (existing) {
      stmts.searchDeleteByRowid.run(existing.rowid);
      stmts.searchMapDeleteByRowid.run(existing.rowid);
    }
    const result = stmts.searchInsertMap.run(e.id, e.type, e.folder || null);
    stmts.searchInsertFts.run(result.lastInsertRowid, e.title || '', e.body || '');
  }
});

export function deleteSearchSession(sessionId: string): void {
  stmts.searchDeleteBySession.run(sessionId);
  stmts.searchMapDeleteBySession.run(sessionId);
}

export function deleteSearchFolder(folder: string): void {
  stmts.searchDeleteByFolder.run(folder);
  stmts.searchMapDeleteByFolder.run(folder);
}

export function deleteSearchType(type: SearchType): void {
  stmts.searchDeleteByType.run(type);
  stmts.searchMapDeleteByType.run(type);
}

export function upsertSearchEntries(entries: SearchEntry[]): void {
  upsertSearchEntriesBatch(entries);
}

export function updateSearchTitle(id: string, type: SearchType, title: string): void {
  try {
    stmts.searchUpdateTitle.run(title, id, type);
  } catch {}
}

export function searchByType(type: SearchType, query: string, limit = 50, titleOnly = false): SearchResult[] {
  try {
    // Wrap in double quotes for exact substring matching with trigram tokenizer.
    // This prevents FTS5 from splitting on punctuation (e.g. "spec.md" → "spec" + "md")
    const escaped = '"' + query.replace(/"/g, '""') + '"';
    // FTS5 column filter: prefix with "title:" to restrict match to title column
    const match = titleOnly ? 'title:' + escaped : escaped;
    return stmts.searchQuery.all(type, match, limit);
  } catch {
    return [];
  }
}

export function isSearchIndexPopulated(): boolean {
  const row = db.prepare<[SearchType], { cnt: number }>('SELECT COUNT(*) as cnt FROM search_map WHERE type = ?').get('session');
  return (row?.cnt ?? 0) > 0;
}

// --- Settings functions ---

/**
 * Settings are stored as JSON. Callers know what they put in, so the return is
 * generic rather than `unknown` — an unparseable value falls back to the raw
 * string, which is how pre-JSON values written by older builds still read back.
 */
export function getSetting<T = unknown>(key: string): T | null {
  const row = stmts.settingsGet.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return row.value as unknown as T; }
}

export function setSetting(key: string, value: unknown): void {
  stmts.settingsUpsert.run(key, JSON.stringify(value));
}

export function deleteSetting(key: string): void {
  stmts.settingsDelete.run(key);
}

export function closeDb(): void {
  try { db.close(); } catch {}
}
