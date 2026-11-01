/**
 * SQLite behind the DeviceRegistry port: the `phone_devices` table.
 *
 * The fingerprint column is UNIQUE, so adding a second device with a
 * fingerprint already enrolled throws rather than leaving two rows the
 * handshake could match.
 */
import type Database from 'better-sqlite3';
import type {DeviceRegistry, EnrolledDevice} from '../../application/ports/phone-access';

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
    private readonly listStatement;
    private readonly byFingerprintStatement;
    private readonly insertStatement;
    private readonly removeStatement;
    private readonly touchStatement;
    private readonly clearStatement;

    constructor(db: Database.Database) {
        this.listStatement = db.prepare<[], Row>('SELECT * FROM phone_devices ORDER BY paired_at, id');
        this.byFingerprintStatement = db.prepare<[string], Row>('SELECT * FROM phone_devices WHERE fingerprint = ?');
        this.insertStatement = db.prepare<[Row]>(`
      INSERT INTO phone_devices (id, name, fingerprint, paired_at, last_seen_at)
      VALUES (@id, @name, @fingerprint, @paired_at, @last_seen_at)
    `);
        this.removeStatement = db.prepare<[string]>('DELETE FROM phone_devices WHERE id = ?');
        this.touchStatement = db.prepare<[number, string]>('UPDATE phone_devices SET last_seen_at = ? WHERE id = ?');
        this.clearStatement = db.prepare('DELETE FROM phone_devices');
    }

    public list(): EnrolledDevice[] {
        return this.listStatement.all().map(toDevice);
    }

    public findByFingerprint(fingerprint: string): EnrolledDevice | null {
        const row = this.byFingerprintStatement.get(fingerprint);
        return row ? toDevice(row) : null;
    }

    public add(device: EnrolledDevice): void {
        this.insertStatement.run({
            id: device.id,
            name: device.name,
            fingerprint: device.fingerprint,
            paired_at: device.pairedAt,
            last_seen_at: device.lastSeenAt,
        });
    }

    public remove(id: string): void {
        this.removeStatement.run(id);
    }

    public touch(id: string, at: number): void {
        this.touchStatement.run(at, id);
    }

    public clear(): void {
        this.clearStatement.run();
    }
}
