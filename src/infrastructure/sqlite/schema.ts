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
    fileMtime TEXT,
    pullRequests TEXT
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
    // The Session work queue: one row per action handed to a session, so a
    // queued one survives a restart (A2). A new table needs no numbered
    // migration: IF NOT EXISTS creates it on any database, whatever its version.
    `CREATE TABLE IF NOT EXISTS session_actions (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    repository TEXT NOT NULL DEFAULT '',
    item_key TEXT NOT NULL,
    action TEXT NOT NULL,
    origin TEXT NOT NULL,
    phase TEXT NOT NULL,
    prompt TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    sent_at TEXT,
    done_at TEXT,
    details TEXT
  )`,
    // What auto-fix did to each PR's checks: attempts, green runs and give-ups,
    // so the limit of two attempts per check survives a restart (W3).
    `CREATE TABLE IF NOT EXISTS auto_fix_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    check_name TEXT NOT NULL,
    head_sha TEXT NOT NULL DEFAULT '',
    origin TEXT,
    activity_id TEXT,
    at TEXT NOT NULL
  )`,
    // The phones enrolled for Phone access (#194), one row per paired device.
    // The fingerprint is what a phone is recognised by during the TLS handshake,
    // so no two rows may share one. Times are epoch ms.
    `CREATE TABLE IF NOT EXISTS phone_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    paired_at INTEGER NOT NULL,
    last_seen_at INTEGER
  )`,
    // Which session works on which BlaakTasks task, and in which repo (#245). A
    // row without a session is a task's repo set by hand. Times are epoch ms.
    `CREATE TABLE IF NOT EXISTS task_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    session_id TEXT,
    source TEXT NOT NULL,
    linked_at INTEGER NOT NULL
  )`,
    // The plans pinned to the top of the session list: a plan is the sessions
    // sharing a slug within one project, so the pin is keyed on both and holds
    // for sessions started from the plan later.
    `CREATE TABLE IF NOT EXISTS pinned_plans (
    project_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    PRIMARY KEY (project_path, slug)
  )`,
    // The GitHub plans pinned to the top of the session list, from the plan's
    // own page. Keyed on the project the page was in and the plan's issue; the
    // title is kept as it was when pinned, so the row needs no GitHub call.
    // Epoch ms for pinned_at.
    `CREATE TABLE IF NOT EXISTS pinned_issue_plans (
    project_path TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    pinned_at INTEGER NOT NULL,
    PRIMARY KEY (project_path, repository, number)
  )`,
    // When a session was unlinked from its task by hand, so detection does not
    // relink it from a tool call made before (#245). Epoch ms.
    `CREATE TABLE IF NOT EXISTS task_unlinks (
    session_id TEXT PRIMARY KEY,
    unlinked_at INTEGER NOT NULL
  )`,
];

const INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_session_cache_folder ON session_cache(folder)',
    'CREATE INDEX IF NOT EXISTS idx_session_cache_slug ON session_cache(slug)',
    'CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)',
    'CREATE INDEX IF NOT EXISTS idx_session_actions_phase ON session_actions(phase)',
    'CREATE INDEX IF NOT EXISTS idx_auto_fix_attempts_pr ON auto_fix_attempts(repository, number)',
    'CREATE INDEX IF NOT EXISTS idx_task_links_task ON task_links(task_id)',
    // A session works on at most one task.
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_session ON task_links(session_id) WHERE session_id IS NOT NULL',
];

/**
 * Run a statement a numbered migration can do without.
 *
 * The early migrations ran against databases of every age, some of which never
 * had the table or already had the column; for those there is nothing to do,
 * and the migration should still be recorded as done.
 */
function execTolerantly(db: Database.Database, sql: string): void {
    try {
        db.exec(sql);
    } catch {
        // Nothing there to change.
    }
}

/**
 * The statements that make the next start re-read every transcript: the cached
 * sessions, and the per-folder stamps that would otherwise tell the indexer a
 * folder is up to date.
 */
const FORGET_INDEXED_SESSIONS = ['DELETE FROM session_cache', 'DELETE FROM cache_meta'];

type Migration = (db: Database.Database, result: SchemaResult) => void;

/**
 * The numbered migrations; the database records how many it has run as
 * `db_version`. Each runs once, in order, so only ever append: a position here
 * is a version number some database out there already counts by.
 */
const MIGRATIONS: Migration[] = [
    // v1: did nothing v2 does not redo.
    () => {},
    // v2: worktree sessions were cached under the wrong project path. Throw the
    // index away, search included, and let the next start rebuild it.
    (db, result) => {
        for (const sql of FORGET_INDEXED_SESSIONS) execTolerantly(db, sql);
        execTolerantly(db, 'DELETE FROM search_map');
        execTolerantly(db, 'DROP TABLE IF EXISTS search_fts');
        result.searchFtsRecreated = true;
    },
    // v3: the AI-generated title got a column of its own, and only a re-index
    // fills it in for sessions already cached.
    //
    // v0.0.29 wrote AI titles into the user-name column, clobbering manual
    // renames. There is no way to tell afterwards which names came from an AI
    // title and which the user typed, so that pollution is left alone rather
    // than guessed at: only future indexes are clean.
    (db) => {
        execTolerantly(db, 'ALTER TABLE session_cache ADD COLUMN aiTitle TEXT');
        for (const sql of FORGET_INDEXED_SESSIONS) execTolerantly(db, sql);
    },
    // v4: once added fileMtime; that is now the reconciliation's job, which
    // goes by the columns a database has rather than by its version.
    () => {},
    // v5: re-index so sessions a tool ran with `claude -p` drop out of the cache.
    // They are no longer listed, but a cached one whose transcript never changes
    // again would otherwise stay. Only a cache: a database a parallel branch
    // already took past v5 keeps a few stale rows, nothing worse.
    (db) => {
        for (const sql of FORGET_INDEXED_SESSIONS) execTolerantly(db, sql);
    },
];

function readVersion(db: Database.Database): number {
    try {
        const row = db.prepare<[], {value: string}>("SELECT value FROM settings WHERE key = 'db_version'").get();
        return row ? (JSON.parse(row.value) as number) : 0;
    } catch {
        return 0;
    }
}

/** A column the queries depend on, and what its arrival means for what is cached. */
interface RequiredColumn {
    table: string;
    column: string;
    type: string;
    /**
     * Rows cached before the column existed are wrong without it, and stay
     * wrong: the indexer only re-reads a transcript whose file changed. So its
     * arrival throws the cache away and the next start rebuilds it.
     */
    staleCache?: boolean;
}

const REQUIRED_COLUMNS: RequiredColumn[] = [
    {table: 'session_cache', column: 'aiTitle', type: 'TEXT'},
    // The transcript's own mtime, the indexer's per-session gate. Before it,
    // `modified` held that mtime; since, it holds the last message's time. A
    // cached row from before says the former, and a folder nobody touches again
    // would show it for good.
    {table: 'session_cache', column: 'fileMtime', type: 'TEXT', staleCache: true},
    // A JSON array of {number, url, repository}. A row cached before it would
    // read as "no PRs" until its transcript next changes.
    {table: 'session_cache', column: 'pullRequests', type: 'TEXT', staleCache: true},
    // When a snoozed session's row comes back, as an ISO time; NULL when awake.
    {table: 'session_meta', column: 'snoozedUntil', type: 'TEXT'},
    // An action's card details (an auto-fix attempt, the attempts it gave up
    // after), as JSON. A queue table from before it has no rows that need any.
    {table: 'session_actions', column: 'details', type: 'TEXT'},
];

function columnsOf(db: Database.Database, table: string): Set<string> {
    const rows = db.prepare<[], {name: string}>(`PRAGMA table_info(${table})`).all();
    return new Set(rows.map((row) => row.name));
}

/**
 * Add whichever required column a database lacks.
 *
 * Errors here are deliberately NOT swallowed: a transient failure (SQLITE_BUSY,
 * say) must not leave a database that looks reconciled — the next launch simply
 * tries again.
 */
function reconcileColumns(db: Database.Database): void {
    for (const {table, column, type, staleCache} of REQUIRED_COLUMNS) {
        if (columnsOf(db, table).has(column)) continue;
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        if (staleCache) for (const sql of FORGET_INDEXED_SESSIONS) db.exec(sql);
    }
}

/** Create what is missing, migrate what is old, and reconcile what is odd. */
export function applySchema(db: Database.Database): SchemaResult {
    const result: SchemaResult = {searchFtsRecreated: false};

    // The settings table has to exist before the version can be read out of it,
    // and the migrations run against tables the DDL above creates.
    for (const ddl of TABLES) db.exec(ddl);
    for (const ddl of INDEXES) db.exec(ddl);

    const version = readVersion(db);
    for (let i = version; i < MIGRATIONS.length; i++) MIGRATIONS[i](db, result);
    if (MIGRATIONS.length > version) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(
            JSON.stringify(MIGRATIONS.length),
        );
    }

    // A migration may have dropped the FTS table; recreate it before anything
    // prepares a statement against it.
    for (const ddl of TABLES) db.exec(ddl);

    reconcileColumns(db);

    return result;
}
