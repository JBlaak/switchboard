/**
 * The database's shape, and how an existing one is brought up to it.
 *
 * Two mechanisms, deliberately. Numbered migrations handle changes that need to
 * happen once and in order. *Schema reconciliation* handles required columns by
 * inspecting the actual schema, because numbered migrations cannot be trusted
 * to add one: a database already migrated to a HIGHER version by a build from a
 * parallel branch skips this branch's migrations entirely, and every prepare()
 * against the missing column then crashes the app at startup.
 */
import type Database from 'better-sqlite3';

export interface SchemaResult {
  /**
   * True when the full-text table was dropped and recreated, so it holds
   * nothing and a re-index is owed regardless of what the cache says.
   */
  searchFtsRecreated: boolean;
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS session_meta (
    sessionId TEXT PRIMARY KEY,
    name TEXT,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS session_cache (
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
  )`,
  `CREATE TABLE IF NOT EXISTS cache_meta (
    folder TEXT PRIMARY KEY,
    projectPath TEXT,
    indexMtimeMs REAL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  // Trigram tokenizer: matches substrings, which is what makes a search for
  // "spec.md" or a fragment of a path find anything at all.
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body, tokenize='trigram case_sensitive 0'
  )`,
  // The FTS table cannot hold non-indexed columns, so the identity of each row
  // lives beside it, joined on rowid.
  `CREATE TABLE IF NOT EXISTS search_map (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    folder TEXT
  )`,
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_session_cache_folder ON session_cache(folder)',
  'CREATE INDEX IF NOT EXISTS idx_session_cache_slug ON session_cache(slug)',
  'CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)',
];

type Migration = (db: Database.Database, result: SchemaResult) => void;

/** Each migration runs once, in order. Add new ones to the end. */
const MIGRATIONS: Migration[] = [
  // v1: superseded by v2.
  () => {},
  // v2: clear the session cache to re-index with corrected worktree paths.
  (db, result) => {
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    result.searchFtsRecreated = true;
  },
  // v3: add aiTitle, and clear the cache so a re-index populates it.
  //
  // v0.0.29 wrote AI titles into the user-name column, clobbering manual
  // renames. There is no way to tell afterwards which names came from an AI
  // title and which the user typed, so that pollution is left alone rather
  // than guessed at: only future indexes are clean.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v4: superseded — fileMtime is added by the reconciliation below, keyed on
  // column presence rather than a version number.
  () => {},
];

function readVersion(db: Database.Database): number {
  try {
    const row = db.prepare<[], { value: string }>(
      "SELECT value FROM settings WHERE key = 'db_version'").get();
    return row ? (JSON.parse(row.value) as number) : 0;
  } catch {
    return 0;
  }
}

/**
 * Ensure the columns the queries below depend on exist.
 *
 * Errors here are deliberately NOT swallowed: a transient failure (SQLITE_BUSY,
 * say) must not be recorded as migrated — the next launch simply retries.
 */
function reconcileColumns(db: Database.Database): void {
  const columns = new Set(
    db.prepare<[], { name: string }>('PRAGMA table_info(session_cache)').all().map(c => c.name));

  if (!columns.has('aiTitle')) db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT');

  if (!columns.has('fileMtime')) {
    db.exec('ALTER TABLE session_cache ADD COLUMN fileMtime TEXT');
    // fileMtime's introduction changed what `modified` means (file mtime →
    // last-message timestamp), so cached values written by pre-fileMtime code
    // are stale. Clear the cache to force a full re-index; without this,
    // dormant folders would keep mtime-based times indefinitely, because the
    // folder-level index gate never re-reads them.
    db.exec('DELETE FROM session_cache');
    db.exec('DELETE FROM cache_meta');
  }
}

/** Create what is missing, migrate what is old, and reconcile what is odd. */
export function applySchema(db: Database.Database): SchemaResult {
  const result: SchemaResult = { searchFtsRecreated: false };

  // The settings table has to exist before the version can be read out of it,
  // and the migrations run against tables the DDL above creates.
  for (const ddl of TABLES) db.exec(ddl);
  for (const ddl of INDEXES) db.exec(ddl);

  const version = readVersion(db);
  for (let i = version; i < MIGRATIONS.length; i++) MIGRATIONS[i](db, result);
  if (MIGRATIONS.length > version) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)")
      .run(JSON.stringify(MIGRATIONS.length));
  }

  // A migration may have dropped the FTS table; recreate it before anything
  // prepares a statement against it.
  for (const ddl of TABLES) db.exec(ddl);

  reconcileColumns(db);

  return result;
}
