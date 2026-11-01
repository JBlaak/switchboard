/**
 * Opening the database.
 *
 * Where it lives, and the pragmas that keep a single-writer desktop app from
 * tripping over itself.
 *
 * Opened explicitly rather than on import: the schema work below writes to the
 * user's disk, and a module that does that as a side effect of being imported
 * cannot be reasoned about — or loaded by a test that only wanted a type.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applySchema} from './schema';

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
    const override = process.env.SWITCHBOARD_DATA_DIR;
    if (override) return path.resolve(override);
    return path.join(os.homedir(), '.switchboard');
}

export function openDatabase(): SwitchboardDatabase {
    const dataDir = resolveDataDir();
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, {recursive: true});

    const db = new Database(path.join(dataDir, 'switchboard.db'));
    // WAL so a read (the sidebar querying) never blocks on a write (the indexer),
    // and a busy timeout so the one case that does contend — two writes — waits
    // instead of throwing SQLITE_BUSY at the user.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    const {searchFtsRecreated} = applySchema(db);

    return {
        db,
        searchFtsRecreated,
        close(): void {
            try {
                db.close();
            } catch {
                // Already closed.
            }
        },
    };
}
