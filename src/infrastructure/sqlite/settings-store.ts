/**
 * SQLite behind the SettingsStore port.
 *
 * Values are stored as JSON. Callers know what they put in, so the read is
 * generic rather than `unknown`; a value that will not parse falls back to the
 * raw string, which is how pre-JSON values written by much older builds still
 * read back.
 */
import type Database from 'better-sqlite3';
import type { SettingsStore } from '../../application/ports/settings-store';

export class SqliteSettingsStore implements SettingsStore {
  readonly #get;
  readonly #upsert;
  readonly #delete;

  constructor(db: Database.Database) {
    this.#get = db.prepare<[string], { value: string }>(
      'SELECT value FROM settings WHERE key = ?');
    this.#upsert = db.prepare<[string, string]>(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.#delete = db.prepare<[string]>('DELETE FROM settings WHERE key = ?');
  }

  get<T = unknown>(key: string): T | null {
    const row = this.#get.get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }

  set(key: string, value: unknown): void {
    this.#upsert.run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.#delete.run(key);
  }
}
