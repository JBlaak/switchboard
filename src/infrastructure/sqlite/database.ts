/**
 * Opening the database.
 *
 * Where it lives, how a database from an older install is inherited, and the
 * pragmas that keep a single-writer desktop app from tripping over itself.
 *
 * Opened explicitly rather than on import: the schema work below writes to the
 * user's disk, and a module that does that as a side effect of being imported
 * cannot be reasoned about — or loaded by a test that only wanted a type.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySchema } from './schema';

export interface SwitchboardDatabase {
  readonly db: Database.Database;
  /** True when a migration emptied the search index, so it needs refilling. */
  readonly searchFtsRecreated: boolean;
  close(): void;
}

/**
 * Where the database lives.
 *
 * SWITCHBOARD_DATA_DIR overrides it so a dev or test instance can run
 * alongside the installed app without sharing its data. The main process
 * isolates Electron's own userData off the same variable, which is what gives
 * each instance its own single-instance lock.
 */
export function resolveDataDir(): string {
  return process.env.SWITCHBOARD_DATA_DIR
    ? path.resolve(process.env.SWITCHBOARD_DATA_DIR)
    : path.join(os.homedir(), '.switchboard');
}

/**
 * Places older builds kept the database.
 *
 * Never consulted when running against an override dir: a dev instance must
 * not relocate the real app's legacy database out from under it.
 */
function legacyLocations(): string[] {
  if (process.env.SWITCHBOARD_DATA_DIR) return [];
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'browser', 'switchboard.db'),
    path.join(home, '.claude', 'browser', 'session-browser.db'),
    path.join(home, '.claude', 'session-browser.db'),
  ];
}

/** Move a database from an older install, with its write-ahead log. */
function inheritLegacyDatabase(dbPath: string): void {
  if (fs.existsSync(dbPath)) return;
  for (const oldPath of legacyLocations()) {
    if (!fs.existsSync(oldPath)) continue;
    fs.renameSync(oldPath, dbPath);
    // The -wal and -shm files are optional; a cleanly closed database has none.
    try { fs.renameSync(oldPath + '-wal', dbPath + '-wal'); } catch {}
    try { fs.renameSync(oldPath + '-shm', dbPath + '-shm'); } catch {}
    return;
  }
}

export function openDatabase(): SwitchboardDatabase {
  const dataDir = resolveDataDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'switchboard.db');
  inheritLegacyDatabase(dbPath);

  const db = new Database(dbPath);
  // WAL so a read (the sidebar querying) never blocks on a write (the indexer),
  // and a busy timeout so the one case that does contend — two writes — waits
  // instead of throwing SQLITE_BUSY at the user.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const { searchFtsRecreated } = applySchema(db);

  return {
    db,
    searchFtsRecreated,
    close(): void {
      try { db.close(); } catch {}
    },
  };
}
