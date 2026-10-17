import test from 'node:test';
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

test('fresh database gets fileMtime column', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-fresh-'));
  try {
    const r = openDatabase(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(inspectDb(dir).cols.includes('fileMtime'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: a DB migrated to db_version 5 by a parallel branch (different
// v4/v5 migrations, extra columns, no fileMtime) skips this branch's
// version-numbered migrations entirely. Startup must still add fileMtime and
// clear the stale cache instead of crashing at prepare().
test('foreign higher-version database is reconciled, not crashed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-foreign-'));
  try {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
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
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = openDatabase(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectDb(dir);
    assert.ok(state.cols.includes('fileMtime'), 'fileMtime column added');
    assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
    assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');
    assert.equal(state.version, '5', 'foreign db_version not downgraded');
    for (const col of ['parentSessionId', 'agentId', 'runtime', 'sessionFile']) {
      assert.ok(state.cols.includes(col), `foreign column ${col} preserved`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh database gets pullRequests column', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-fresh-prs-'));
  try {
    const r = openDatabase(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(inspectDb(dir).cols.includes('pullRequests'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A cache written before pullRequests existed holds rows that would read as
// "no PRs" until their transcript next changes. The column's arrival clears the
// cache and the folder gate so the cold-start rebuild re-reads every session.
test('a cache without pullRequests gains the column and is cleared for re-index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-prs-'));
  try {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
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
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = openDatabase(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectDb(dir);
    assert.ok(state.cols.includes('pullRequests'), 'pullRequests column added');
    assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
    assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');

    // Only once: a second open finds the column and leaves the cache alone.
    const refill = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare("INSERT INTO session_cache (sessionId, folder, pullRequests) VALUES ('s1', 'f1', '[]')").run();
    `, dir);
    assert.equal(refill.status, 0, refill.stderr);
    assert.equal(openDatabase(dir).status, 0);
    assert.equal(inspectDb(dir).cacheCount, 1, 'cache kept once the column exists');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('a fresh database gets the session_actions table', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-actions-'));
  try {
    assert.equal(openDatabase(dir).status, 0);
    assert.deepEqual(sessionActionColumns(dir), SESSION_ACTION_COLUMNS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The Session work queue must survive a restart, so its table is created on
// every database, including one a parallel branch migrated past this one's
// version: a numbered migration would be skipped there.
test('an existing, foreign higher-version database gains session_actions, and keeps its rows across opens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-actions-foreign-'));
  try {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '9')").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);
    assert.equal(openDatabase(dir).status, 0);
    assert.deepEqual(sessionActionColumns(dir), SESSION_ACTION_COLUMNS);

    const queue = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare(\`INSERT INTO session_actions (id, session, item_key, action, origin, phase, prompt, queued_at)
        VALUES ('a1', 's1', 'pr:x', 'ship', 'manual', 'queued', 'Ship PR #1', '2026-01-01T00:00:00Z')\`).run();
    `, dir);
    assert.equal(queue.status, 0, queue.stderr);
    assert.equal(openDatabase(dir).status, 0);
    const count = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
      console.log(String(db.prepare('SELECT COUNT(*) AS n FROM session_actions').get().n));
    `, dir);
    assert.equal(count.stdout.trim().split('\n').pop(), '1', 'a queued action survives the next open');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a session_actions table from before card details gains the column, and keeps its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-actions-details-'));
  try {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec(\`CREATE TABLE session_actions (id TEXT PRIMARY KEY, session TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '',
        item_key TEXT NOT NULL, action TEXT NOT NULL, origin TEXT NOT NULL, phase TEXT NOT NULL, prompt TEXT NOT NULL,
        queued_at TEXT NOT NULL, sent_at TEXT, done_at TEXT)\`);
      db.prepare(\`INSERT INTO session_actions (id, session, item_key, action, origin, phase, prompt, queued_at)
        VALUES ('a1', 's1', 'pr:x', 'ship', 'manual', 'queued', 'Ship PR #1', '2026-01-01T00:00:00Z')\`).run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);
    assert.equal(openDatabase(dir).status, 0);
    assert.deepEqual(sessionActionColumns(dir), SESSION_ACTION_COLUMNS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The auto-fix limit survives a restart only if its history does (W3).
test('the auto-fix history table is created, and its rows survive the next open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-auto-fix-'));
  try {
    assert.equal(openDatabase(dir).status, 0);
    const write = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare(\`INSERT INTO auto_fix_attempts (kind, repository, number, check_name, head_sha, origin, activity_id, at)
        VALUES ('attempt', 'o/app', 7, 'test', 'aaa', 'auto', 'a1', '2026-01-01T00:00:00Z')\`).run();
    `, dir);
    assert.equal(write.status, 0, write.stderr);
    assert.equal(openDatabase(dir).status, 0);
    const read = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
      console.log(JSON.stringify(db.prepare('SELECT kind, head_sha FROM auto_fix_attempts').all()));
    `, dir);
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout.trim().split('\n').pop() ?? '[]'), [{ kind: 'attempt', head_sha: 'aaa' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
