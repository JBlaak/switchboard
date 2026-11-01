/**
 * SQLite behind the SettingsStore port.
 *
 * Values are stored as JSON. Callers know what they put in, so the read is
 * generic rather than `unknown`; a value that will not parse falls back to the
 * raw string, which is how pre-JSON values written by much older builds still
 * read back.
 */
import type Database from 'better-sqlite3';
import type {SettingsStore} from '../../application/ports/settings-store';

export class SqliteSettingsStore implements SettingsStore {
    private readonly getStatement;
    private readonly upsertStatement;
    private readonly deleteStatement;

    constructor(db: Database.Database) {
        this.getStatement = db.prepare<[string], {value: string}>('SELECT value FROM settings WHERE key = ?');
        // The key is the whole row's identity, so replacing the row is the update.
        this.upsertStatement = db.prepare<[string, string]>(
            'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        );
        this.deleteStatement = db.prepare<[string]>('DELETE FROM settings WHERE key = ?');
    }

    public get<T = unknown>(key: string): T | null {
        const row = this.getStatement.get(key);
        if (!row) return null;
        try {
            return JSON.parse(row.value) as T;
        } catch {
            return row.value as unknown as T;
        }
    }

    public set(key: string, value: unknown): void {
        this.upsertStatement.run(key, JSON.stringify(value));
    }

    public delete(key: string): void {
        this.deleteStatement.run(key);
    }
}
