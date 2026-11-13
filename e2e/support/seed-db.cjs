/**
 * Write a fixture's settings and per-session state into a fresh database.
 *
 * Run under Electron-as-Node (`ELECTRON_RUN_AS_NODE=1 electron seed-db.cjs
 * <seed.json>`) with SWITCHBOARD_DATA_DIR pointing at the fixture's data dir:
 * better-sqlite3 is compiled for Electron's ABI, so the Node running Playwright
 * cannot load it — the same reason test/db-schema-reconcile.test.ts runs this
 * way.
 *
 * The database is opened through the app's own built `app/database.js`, so the
 * schema is exactly the one the app will find, and only rows go in: the
 * settings blobs the settings service reads and the `session_meta` rows
 * behind pinning, archiving and renaming, the `vm_transcripts` cache a
 * VM session's row takes its title from (nothing on disk can rebuild that
 * one), and the managers' `inbox_items`, which only a poll would bring. Everything derived from local transcripts is left for the app's own
 * indexer to build.
 */
const fs = require('node:fs');
const path = require('node:path');

const [seedPath] = process.argv.slice(2);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

const {openDatabase} = require(path.join(__dirname, '..', '..', 'app', 'database.js'));
const database = openDatabase();
const {db} = database;

const putSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const putMeta = db.prepare(`
  INSERT INTO session_meta (sessionId, name, starred, archived) VALUES (?, ?, ?, ?)
  ON CONFLICT(sessionId) DO UPDATE SET
    name = excluded.name, starred = excluded.starred, archived = excluded.archived
`);
const putInboxItem = db.prepare(`
  INSERT INTO inbox_items (key, manager, item, updated_at) VALUES (@key, @manager, @item, @updated_at)
`);
const putVmTranscript = db.prepare(`
  INSERT INTO vm_transcripts (session_id, host_key, cwd, mtime_ms, transcript)
  VALUES (@session_id, @host_key, @cwd, @mtime_ms, @transcript)
`);

db.transaction(() => {
    for (const [key, value] of Object.entries(seed.settings || {})) {
        putSetting.run(key, JSON.stringify(value));
    }
    for (const meta of seed.meta || []) {
        putMeta.run(meta.sessionId, meta.name ?? null, meta.starred ? 1 : 0, meta.archived ? 1 : 0);
    }
    for (const row of seed.vmTranscripts || []) {
        putVmTranscript.run(row);
    }
    for (const row of seed.inboxItems || []) {
        putInboxItem.run(row);
    }
})();

database.close();
