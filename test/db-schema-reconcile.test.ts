import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = path.join(__dirname, '..');
// better-sqlite3 is compiled for Electron's ABI, so plain `node` cannot load
// it (or database.js). Run every DB-touching snippet under Electron-as-Node instead.
// Under plain node, require('electron') returns the path to the binary.
// The typings model `electron` as the module the main process gets; under plain
// node it is the path to the binary, which is what spawnSync needs.
import electronBin from 'electron';
const ELECTRON: string = electronBin as unknown as string;

function runInElectronNode(code: string, dataDir: string) {
  return spawnSync(ELECTRON, ['-e', code], {
    cwd: APP_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

// Opening the database applies the schema, so each scenario does it in a fresh
// child process pointed at an isolated data dir. It is the *built* module that
// runs here (scripts/build.mjs emits app/database.js for exactly this):
// better-sqlite3 needs Electron's ABI, so the snippet cannot go through tsx.
const BUILT_DB = path.join(APP_DIR, 'app', 'database.js');

function openDatabase(dataDir: string) {
  assert.ok(
    fs.existsSync(BUILT_DB),
    `${BUILT_DB} is missing — run \`npm run build\` before the tests`,
  );
  return runInElectronNode(`require(${JSON.stringify(BUILT_DB)}).openDatabase().close()`, dataDir);
}

function inspectDb(dataDir: string) {
  const r = runInElectronNode(`
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
    console.log(JSON.stringify({
      cols: db.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name),
      cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
      metaCount: db.prepare('SELECT COUNT(*) AS n FROM cache_meta').get().n,
      version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get()?.value,
    }));
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
}

const dataDirs: string[] = [];
after(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** An isolated, empty data dir, removed once the file's tests are done. */
function dataDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dataDirs.push(dir);
  return dir;
}

/** Run a snippet against the data dir's database (as `db`), failing on a non-zero exit; answers its last line. */
function sqlite(dataDir: string, code: string, readonly = false): string {
  const r = runInElectronNode(`
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db')${readonly ? ', { readonly: true }' : ''});
    ${code}
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').pop() ?? '';
}

/** Open the database as a step towards the scenario, failing if that open fails. */
function opened(dataDir: string): void {
  const r = openDatabase(dataDir);
  assert.equal(r.status, 0, r.stderr);
}

test('fresh database gets fileMtime column', () => {
  /* Given */
  const dir = dataDir('switchboard-db-fresh-');

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0, r.stderr);
  assert.ok(inspectDb(dir).cols.includes('fileMtime'));
});

// Regression: a DB migrated to db_version 5 by a parallel branch (different
// v4/v5 migrations, extra columns, no fileMtime) skips this branch's
// version-numbered migrations entirely. Startup must still add fileMtime and
// clear the stale cache instead of crashing at prepare().
test('foreign higher-version database is reconciled, not crashed', () => {
  /* Given */
  const dir = dataDir('switchboard-db-foreign-');
  sqlite(dir, `
    db.exec(\`CREATE TABLE session_cache (
      sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
      summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
      messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT,
      parentSessionId TEXT, agentId TEXT, subagentType TEXT,
      description TEXT, runtime TEXT DEFAULT 'claude', sessionFile TEXT
    )\`);
    db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '5')").run();
    db.prepare("INSERT INTO session_cache (sessionId, folder, modified) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO cache_meta (folder, indexMtimeMs) VALUES ('f1', 123)").run();
  `);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0, r.stderr);
  const state = inspectDb(dir);
  assert.ok(state.cols.includes('fileMtime'), 'fileMtime column added');
  assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
  assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');
  assert.equal(state.version, '5', 'foreign db_version not downgraded');
  for (const col of ['parentSessionId', 'agentId', 'runtime', 'sessionFile']) {
    assert.ok(state.cols.includes(col), `foreign column ${col} preserved`);
  }
});

test('fresh database gets pullRequests column', () => {
  /* Given */
  const dir = dataDir('switchboard-db-fresh-prs-');

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0, r.stderr);
  assert.ok(inspectDb(dir).cols.includes('pullRequests'));
});

/** A v4 cache from before pullRequests existed, holding one session and its folder gate. */
const CACHE_WITHOUT_PULL_REQUESTS = `
  db.exec(\`CREATE TABLE session_cache (
    sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
    summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
    messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT, fileMtime TEXT
  )\`);
  db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '4')").run();
  db.prepare("INSERT INTO session_cache (sessionId, folder, modified, fileMtime) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO cache_meta (folder, indexMtimeMs) VALUES ('f1', 123)").run();
`;

// A cache written before pullRequests existed holds rows that would read as
// "no PRs" until their transcript next changes. The column's arrival clears the
// cache and the folder gate so the cold-start rebuild re-reads every session.
test('a cache without pullRequests gains the column and is cleared for re-index', () => {
  /* Given */
  const dir = dataDir('switchboard-db-prs-');
  sqlite(dir, CACHE_WITHOUT_PULL_REQUESTS);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0, r.stderr);
  const state = inspectDb(dir);
  assert.ok(state.cols.includes('pullRequests'), 'pullRequests column added');
  assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
  assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');
});

test('the pullRequests re-index happens only once', () => {
  // Only once: a second open finds the column and leaves the cache alone.
  /* Given */
  const dir = dataDir('switchboard-db-prs-once-');
  sqlite(dir, CACHE_WITHOUT_PULL_REQUESTS);
  opened(dir);
  sqlite(dir, `db.prepare("INSERT INTO session_cache (sessionId, folder, pullRequests) VALUES ('s1', 'f1', '[]')").run();`);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0);
  assert.equal(inspectDb(dir).cacheCount, 1, 'cache kept once the column exists');
});

function sessionActionColumns(dataDir: string): string[] {
  const r = runInElectronNode(`
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
    console.log(JSON.stringify(db.prepare('PRAGMA table_info(session_actions)').all().map(c => c.name)));
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]');
}

const SESSION_ACTION_COLUMNS = [
  'id', 'session', 'repository', 'item_key', 'action', 'origin', 'phase', 'prompt', 'queued_at', 'sent_at', 'done_at',
  'details',
];

/** A database a parallel branch migrated past this one's version, with nothing else in it. */
const FOREIGN_V9 = `
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '9')").run();
`;

const QUEUE_ONE_ACTION = `
  db.prepare(\`INSERT INTO session_actions (id, session, item_key, action, origin, phase, prompt, queued_at)
    VALUES ('a1', 's1', 'pr:x', 'ship', 'manual', 'queued', 'Ship PR #1', '2026-01-01T00:00:00Z')\`).run();
`;

test('a fresh database gets the session_actions table', () => {
  /* Given */
  const dir = dataDir('switchboard-db-actions-');

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0);
  assert.deepEqual(sessionActionColumns(dir), SESSION_ACTION_COLUMNS);
});

// The Session work queue must survive a restart, so its table is created on
// every database, including one a parallel branch migrated past this one's
// version: a numbered migration would be skipped there.
test('an existing, foreign higher-version database gains session_actions', () => {
  /* Given */
  const dir = dataDir('switchboard-db-actions-foreign-');
  sqlite(dir, FOREIGN_V9);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0);
  assert.deepEqual(sessionActionColumns(dir), SESSION_ACTION_COLUMNS);
});

test('an existing, foreign higher-version database keeps its session_actions rows across opens', () => {
  /* Given */
  const dir = dataDir('switchboard-db-actions-foreign-rows-');
  sqlite(dir, FOREIGN_V9);
  opened(dir);
  sqlite(dir, QUEUE_ONE_ACTION);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0);
  const count = sqlite(dir, `console.log(String(db.prepare('SELECT COUNT(*) AS n FROM session_actions').get().n));`, true);
  assert.equal(count, '1', 'a queued action survives the next open');
});

test('a session_actions table from before card details gains the column, and keeps its rows', () => {
  /* Given */
  const dir = dataDir('switchboard-db-actions-details-');
  sqlite(dir, `
    db.exec(\`CREATE TABLE session_actions (id TEXT PRIMARY KEY, session TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '',
      item_key TEXT NOT NULL, action TEXT NOT NULL, origin TEXT NOT NULL, phase TEXT NOT NULL, prompt TEXT NOT NULL,
      queued_at TEXT NOT NULL, sent_at TEXT, done_at TEXT)\`);
    ${QUEUE_ONE_ACTION}
  `);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0);
  assert.deepEqual(sessionActionColumns(dir), SESSION_ACTION_COLUMNS);
});

// The auto-fix limit survives a restart only if its history does (W3).
test('the auto-fix history table is created, and its rows survive the next open', () => {
  /* Given */
  const dir = dataDir('switchboard-db-auto-fix-');
  opened(dir);
  sqlite(dir, `
    db.prepare(\`INSERT INTO auto_fix_attempts (kind, repository, number, check_name, head_sha, origin, activity_id, at)
      VALUES ('attempt', 'o/app', 7, 'test', 'aaa', 'auto', 'a1', '2026-01-01T00:00:00Z')\`).run();
  `);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0);
  const rows = sqlite(dir, `console.log(JSON.stringify(db.prepare('SELECT kind, head_sha FROM auto_fix_attempts').all()));`, true);
  assert.deepEqual(JSON.parse(rows || '[]'), [{ kind: 'attempt', head_sha: 'aaa' }]);
});

test('a session_meta table from before snoozing gains snoozedUntil, and keeps its rows', () => {
  /* Given */
  const dir = dataDir('switchboard-db-snooze-');
  sqlite(dir, `
    db.exec('CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, name TEXT, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)');
    db.prepare("INSERT INTO session_meta (sessionId, name) VALUES ('s1', 'Kept')").run();
  `);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(sqlite(dir, `console.log(JSON.stringify(db.prepare("SELECT * FROM session_meta WHERE sessionId = 's1'").get()))`, true));
  assert.deepEqual(row, { sessionId: 's1', name: 'Kept', starred: 0, archived: 0, snoozedUntil: null });
});

// The enrolled phones (#194) must be there on every database, including one a
// parallel branch migrated past this one's version.
test('a foreign higher-version database gains phone_devices, and its rows survive the next open', () => {
  /* Given */
  const dir = dataDir('switchboard-db-phone-devices-');
  sqlite(dir, FOREIGN_V9);
  opened(dir);
  sqlite(dir, `
    db.prepare(\`INSERT INTO phone_devices (id, name, fingerprint, paired_at, last_seen_at)
      VALUES ('d1', 'Pixel 9 Pro', 'aa', 1700000000000, NULL)\`).run();
  `);

  /* When */
  const r = openDatabase(dir);

  /* Then */
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(sqlite(dir, `console.log(JSON.stringify({
    cols: db.prepare('PRAGMA table_info(phone_devices)').all().map(c => c.name),
    rows: db.prepare('SELECT id FROM phone_devices').all(),
  }));`, true));
  assert.deepEqual(state, {
    cols: ['id', 'name', 'fingerprint', 'paired_at', 'last_seen_at'],
    rows: [{ id: 'd1' }],
  });
});
