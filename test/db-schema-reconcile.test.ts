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
      metaCols: db.prepare('PRAGMA table_info(cache_meta)').all().map(c => c.name),
      cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
      metaCount: db.prepare('SELECT COUNT(*) AS n FROM cache_meta').get().n,
      version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get()?.value,
    }));
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
}

test('fresh database gets the fileMtime and cwd columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-fresh-'));
  try {
    const r = openDatabase(dir);
    assert.equal(r.status, 0, r.stderr);
    const state = inspectDb(dir);
    assert.ok(state.cols.includes('fileMtime'));
    assert.ok(state.metaCols.includes('cwd'));
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
    // The seed's cache_meta predates cwd, as every install upgraded from an
    // earlier build does; the column has to appear without a version bump.
    assert.ok(state.metaCols.includes('cwd'), 'cwd column added to cache_meta');
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
