/**
 * SQLite behind the DeviceRegistry port: the `phone_devices` table.
 *
 * The fingerprint column is UNIQUE, so adding a second device with a
 * fingerprint already enrolled throws rather than leaving two rows the
 * handshake could match.
 */
import type Database from 'better-sqlite3';
import type { DeviceRegistry, EnrolledDevice } from '../../application/ports/phone-access';

interface Row {
  id: string;
  name: string;
  fingerprint: string;
  paired_at: number;
  last_seen_at: number | null;
}

function toDevice(row: Row): EnrolledDevice {
  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class SqliteDeviceRegistry implements DeviceRegistry {
  readonly #list;
  readonly #byFingerprint;
  readonly #insert;
  readonly #remove;
  readonly #touch;
  readonly #clear;

  constructor(db: Database.Database) {
    this.#list = db.prepare<[], Row>('SELECT * FROM phone_devices ORDER BY paired_at, id');
    this.#byFingerprint = db.prepare<[string], Row>('SELECT * FROM phone_devices WHERE fingerprint = ?');
    this.#insert = db.prepare<[Row]>(`
      INSERT INTO phone_devices (id, name, fingerprint, paired_at, last_seen_at)
      VALUES (@id, @name, @fingerprint, @paired_at, @last_seen_at)
    `);
    this.#remove = db.prepare<[string]>('DELETE FROM phone_devices WHERE id = ?');
    this.#touch = db.prepare<[number, string]>('UPDATE phone_devices SET last_seen_at = ? WHERE id = ?');
    this.#clear = db.prepare('DELETE FROM phone_devices');
  }

  list(): EnrolledDevice[] {
    return this.#list.all().map(toDevice);
  }

  findByFingerprint(fingerprint: string): EnrolledDevice | null {
    const row = this.#byFingerprint.get(fingerprint);
    return row ? toDevice(row) : null;
  }

  add(device: EnrolledDevice): void {
    this.#insert.run({
      id: device.id,
      name: device.name,
      fingerprint: device.fingerprint,
      paired_at: device.pairedAt,
      last_seen_at: device.lastSeenAt,
    });
  }

  remove(id: string): void {
    this.#remove.run(id);
  }

  touch(id: string, at: number): void {
    this.#touch.run(at, id);
  }

  clear(): void {
    this.#clear.run();
  }
}
