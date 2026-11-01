/**
 * Opening a database brings it up to the current shape, whatever build last
 * wrote it: a fresh one, an old one from before a column existed, or one a
 * parallel branch numbered past this branch's migrations.
 *
 * better-sqlite3 is compiled for Electron's ABI, so neither it nor the code
 * that opens the database can load under plain node or tsx. Each step runs as
 * a script in a fresh Electron-as-Node process instead, pointed at its own data
 * dir, and the app's side of it is the built bundle (scripts/build.mjs emits
 * app/database.js for this).
 */
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Typed as the module the main process sees; under plain node it is the path
// to the Electron binary, which is what a spawn needs.
import electronBinary from 'electron';

const ELECTRON = electronBinary as unknown as string;
const ROOT = path.resolve(__dirname, '..');
const BUILT_DATABASE = path.join(ROOT, 'app', 'database.js');

/** Run a script as Electron-as-Node against a data dir, answering how it went. */
function runScript(dataDir: string, script: string) {
    const env = {...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir};
    return spawnSync(ELECTRON, ['-e', script], {cwd: ROOT, env, encoding: 'utf8'});
}

/** Open and close the database the way the app does at startup, schema work and all. */
function openAsTheAppDoes(dataDir: string) {
    assert.ok(fs.existsSync(BUILT_DATABASE), `no ${BUILT_DATABASE}: \`npm run build\` before the tests`);
    return runScript(dataDir, `require(${JSON.stringify(BUILT_DATABASE)}).openDatabase().close();`);
}

/** Open it as a step on the way to the scenario, which must not fail. */
function openedAsTheAppDoes(dataDir: string): void {
    const run = openAsTheAppDoes(dataDir);
    assert.equal(run.status, 0, run.stderr);
}

/** A script body with `db` open on the data dir's database; answers the last line it prints. */
function withDatabase(dataDir: string, body: string, options: {readonly: boolean}): string {
    const run = runScript(
        dataDir,
        `const Database = require('better-sqlite3');
        const file = require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db');
        const db = new Database(file, ${JSON.stringify(options)});
        ${body}`,
    );
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim().split('\n').pop() ?? '';
}

/** Write to the database directly, as an older or foreign build would have. */
function seed(dataDir: string, statements: readonly string[]): void {
    withDatabase(dataDir, `for (const sql of ${JSON.stringify(statements)}) db.exec(sql);`, {readonly: false});
}

function rows<T>(dataDir: string, sql: string): T[] {
    const json = withDatabase(dataDir, `console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));`, {
        readonly: true,
    });
    return JSON.parse(json) as T[];
}

function columnsOf(dataDir: string, table: string): string[] {
    return rows<{name: string}>(dataDir, `PRAGMA table_info(${table})`).map((column) => column.name);
}

function rowCount(dataDir: string, table: string): number {
    return rows<{n: number}>(dataDir, `SELECT COUNT(*) AS n FROM ${table}`)[0].n;
}

function storedVersion(dataDir: string): string | undefined {
    return rows<{value: string}>(dataDir, "SELECT value FROM settings WHERE key = 'db_version'")[0]?.value;
}

const dataDirs: string[] = [];
after(() => {
    for (const dir of dataDirs) fs.rmSync(dir, {recursive: true, force: true});
});

/** A data dir of its own, empty, removed once the file's tests are done. */
function freshDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-'));
    dataDirs.push(dir);
    return dir;
}

// ── Fixtures: what older and foreign builds left behind ──

const CACHE_META_TABLE = 'CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)';
const SETTINGS_TABLE = 'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)';
const atVersion = (version: number) => `INSERT INTO settings (key, value) VALUES ('db_version', '${version}')`;
const FOLDER_STAMP = "INSERT INTO cache_meta (folder, indexMtimeMs) VALUES ('f1', 123)";

/**
 * A parallel branch's database at v5: its own v4 and v5, columns this branch
 * never had, and no fileMtime. The version alone would skip every migration
 * here.
 */
const FOREIGN_V5_WITHOUT_FILE_MTIME = [
    `CREATE TABLE session_cache (sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT, summary TEXT,
        firstPrompt TEXT, created TEXT, modified TEXT, messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT,
        parentSessionId TEXT, agentId TEXT, subagentType TEXT, description TEXT, runtime TEXT DEFAULT 'claude',
        sessionFile TEXT)`,
    CACHE_META_TABLE,
    SETTINGS_TABLE,
    atVersion(5),
    "INSERT INTO session_cache (sessionId, folder, modified) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z')",
    FOLDER_STAMP,
];

/** This branch's v4, from before pullRequests: one cached session and its folder's stamp. */
const V4_WITHOUT_PULL_REQUESTS = [
    `CREATE TABLE session_cache (sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT, summary TEXT,
        firstPrompt TEXT, created TEXT, modified TEXT, messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT,
        fileMtime TEXT)`,
    CACHE_META_TABLE,
    SETTINGS_TABLE,
    atVersion(4),
    `INSERT INTO session_cache (sessionId, folder, modified, fileMtime)
        VALUES ('s1', 'f1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    FOLDER_STAMP,
];

/** A parallel branch's database at v9, with nothing in it but its version. */
const FOREIGN_V9 = [SETTINGS_TABLE, atVersion(9)];

const QUEUED_ACTION = `INSERT INTO session_actions (id, session, item_key, action, origin, phase, prompt, queued_at)
    VALUES ('a1', 's1', 'pr:x', 'ship', 'manual', 'queued', 'Ship PR #1', '2026-01-01T00:00:00Z')`;

const SESSION_ACTION_COLUMNS = [
    'id',
    'session',
    'repository',
    'item_key',
    'action',
    'origin',
    'phase',
    'prompt',
    'queued_at',
    'sent_at',
    'done_at',
    'details',
];

// ── The session cache ──

test('a fresh database has the fileMtime and pullRequests columns', () => {
    /* Given */
    const dir = freshDataDir();

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    const columns = columnsOf(dir, 'session_cache');
    assert.ok(columns.includes('fileMtime'), 'fileMtime');
    assert.ok(columns.includes('pullRequests'), 'pullRequests');
});

test('a database at v1 runs every migration since, and ends up indexed afresh at the latest version', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, [
        `CREATE TABLE session_cache (sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT, summary TEXT,
            firstPrompt TEXT, created TEXT, modified TEXT, messageCount INTEGER DEFAULT 0, slug TEXT)`,
        CACHE_META_TABLE,
        SETTINGS_TABLE,
        'CREATE TABLE search_map (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, type TEXT NOT NULL, folder TEXT)',
        atVersion(1),
        "INSERT INTO session_cache (sessionId, folder) VALUES ('s1', 'f1')",
        FOLDER_STAMP,
        "INSERT INTO search_map (id, type, folder) VALUES ('s1', 'session', 'f1')",
    ]);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.equal(storedVersion(dir), '5');
    assert.ok(columnsOf(dir, 'session_cache').includes('aiTitle'), 'aiTitle added');
    assert.equal(rowCount(dir, 'session_cache'), 0, 'cached sessions dropped for a re-index');
    assert.equal(rowCount(dir, 'cache_meta'), 0, 'folder stamps dropped');
    assert.equal(rowCount(dir, 'search_map'), 0, 'search entries dropped');
    assert.equal(rowCount(dir, 'search_fts'), 0, 'the full-text table is there again, empty');
});

// The startup crash this guards against: every statement prepared against
// fileMtime failed on such a database.
test('a foreign database past our version gains fileMtime and a re-index, and keeps its version and columns', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, FOREIGN_V5_WITHOUT_FILE_MTIME);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    const columns = columnsOf(dir, 'session_cache');
    assert.ok(columns.includes('fileMtime'), 'fileMtime added');
    assert.equal(rowCount(dir, 'session_cache'), 0, 'cached sessions dropped for a re-index');
    assert.equal(rowCount(dir, 'cache_meta'), 0, 'folder stamps dropped, so every folder is re-read');
    assert.equal(storedVersion(dir), '5', 'its version is not taken back');
    for (const column of ['parentSessionId', 'agentId', 'runtime', 'sessionFile']) {
        assert.ok(columns.includes(column), `its ${column} column is left in place`);
    }
});

// A session cached before pullRequests existed would read as having no PRs
// until its transcript next changed.
test('a cache from before pullRequests gains the column and a re-index', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, V4_WITHOUT_PULL_REQUESTS);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.ok(columnsOf(dir, 'session_cache').includes('pullRequests'), 'pullRequests added');
    assert.equal(rowCount(dir, 'session_cache'), 0, 'cached sessions dropped for a re-index');
    assert.equal(rowCount(dir, 'cache_meta'), 0, 'folder stamps dropped, so every folder is re-read');
});

test('the re-index for pullRequests happens on the first open only', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, V4_WITHOUT_PULL_REQUESTS);
    openedAsTheAppDoes(dir);
    seed(dir, ["INSERT INTO session_cache (sessionId, folder, pullRequests) VALUES ('s1', 'f1', '[]')"]);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.equal(rowCount(dir, 'session_cache'), 1, 'the session cached since is kept');
});

// ── Session work and auto-fix ──

test('a fresh database has the session_actions table', () => {
    /* Given */
    const dir = freshDataDir();

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(columnsOf(dir, 'session_actions'), SESSION_ACTION_COLUMNS);
});

// The Session work queue survives a restart only if its table is there on every
// database, including one whose version would skip a numbered migration.
test('a foreign database past our version gains the session_actions table', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, FOREIGN_V9);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(columnsOf(dir, 'session_actions'), SESSION_ACTION_COLUMNS);
});

test('a foreign database past our version keeps its queued actions on the next open', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, FOREIGN_V9);
    openedAsTheAppDoes(dir);
    seed(dir, [QUEUED_ACTION]);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.equal(rowCount(dir, 'session_actions'), 1);
});

test('a session_actions table from before card details gains the column and keeps its rows', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, [
        `CREATE TABLE session_actions (id TEXT PRIMARY KEY, session TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '',
            item_key TEXT NOT NULL, action TEXT NOT NULL, origin TEXT NOT NULL, phase TEXT NOT NULL,
            prompt TEXT NOT NULL, queued_at TEXT NOT NULL, sent_at TEXT, done_at TEXT)`,
        QUEUED_ACTION,
    ]);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(columnsOf(dir, 'session_actions'), SESSION_ACTION_COLUMNS);
    assert.equal(rowCount(dir, 'session_actions'), 1);
});

// The limit of two auto-fix attempts per check only holds across a restart if
// the attempts do (W3).
test('the auto-fix history is created, and what it records survives the next open', () => {
    /* Given */
    const dir = freshDataDir();
    openedAsTheAppDoes(dir);
    seed(dir, [
        `INSERT INTO auto_fix_attempts (kind, repository, number, check_name, head_sha, origin, activity_id, at)
            VALUES ('attempt', 'o/app', 7, 'test', 'aaa', 'auto', 'a1', '2026-01-01T00:00:00Z')`,
    ]);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(rows(dir, 'SELECT kind, head_sha FROM auto_fix_attempts'), [{kind: 'attempt', head_sha: 'aaa'}]);
});

// ── Session metadata ──

test('a session_meta table from before snoozing gains snoozedUntil and keeps its rows', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, [
        'CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, name TEXT, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)',
        "INSERT INTO session_meta (sessionId, name) VALUES ('s1', 'Kept')",
    ]);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(rows(dir, "SELECT * FROM session_meta WHERE sessionId = 's1'"), [
        {sessionId: 's1', name: 'Kept', starred: 0, archived: 0, snoozedUntil: null},
    ]);
});

// ── Phones and tasks ──

// The enrolled phones (#194) have to be there whatever the database's version.
test('a foreign database past our version gains phone_devices, and a paired phone survives the next open', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, FOREIGN_V9);
    openedAsTheAppDoes(dir);
    seed(dir, [
        `INSERT INTO phone_devices (id, name, fingerprint, paired_at, last_seen_at)
            VALUES ('d1', 'Pixel 9 Pro', 'aa', 1700000000000, NULL)`,
    ]);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(columnsOf(dir, 'phone_devices'), ['id', 'name', 'fingerprint', 'paired_at', 'last_seen_at']);
    assert.deepEqual(rows(dir, 'SELECT id FROM phone_devices'), [{id: 'd1'}]);
});

// Which session works on which task (#245) has to be there whatever the
// database's version.
test('a foreign database past our version gains task_links and task_unlinks, and their rows survive the next open', () => {
    /* Given */
    const dir = freshDataDir();
    seed(dir, FOREIGN_V9);
    openedAsTheAppDoes(dir);
    seed(dir, [
        `INSERT INTO task_links (task_id, project_path, session_id, source, linked_at)
            VALUES ('1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9', '/code/app', 's1', 'start', 1700000000000)`,
        "INSERT INTO task_unlinks (session_id, unlinked_at) VALUES ('s2', 1700000000000)",
    ]);

    /* When */
    const run = openAsTheAppDoes(dir);

    /* Then */
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(columnsOf(dir, 'task_links'), [
        'id',
        'task_id',
        'project_path',
        'session_id',
        'source',
        'linked_at',
    ]);
    assert.deepEqual(rows(dir, 'SELECT session_id FROM task_links'), [{session_id: 's1'}]);
    assert.deepEqual(columnsOf(dir, 'task_unlinks'), ['session_id', 'unlinked_at']);
    assert.deepEqual(rows(dir, 'SELECT session_id FROM task_unlinks'), [{session_id: 's2'}]);
});
