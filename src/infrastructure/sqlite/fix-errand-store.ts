/**
 * SQLite behind the FixErrandStore port: the `fix_errands` table (#437).
 *
 * An errand is kept as JSON, read and written whole, like a landed PR. A row
 * that does not parse as an errand (another build's, or a damaged one) is
 * skipped rather than failing the launch.
 */
import type Database from 'better-sqlite3';
import type {FixErrandStore} from '../../application/ports/fix-errand-store';
import type {FixErrand} from '../../domain/merge-manager/errands';

interface Row {
    id: string;
    errand: string;
}

function toErrand(row: Row): FixErrand | null {
    try {
        const errand = JSON.parse(row.errand) as FixErrand;
        if (
            errand?.id !== row.id ||
            typeof errand.key !== 'string' ||
            typeof errand.repository !== 'string' ||
            typeof errand.number !== 'number' ||
            typeof errand.branch !== 'string' ||
            typeof errand.sessionId !== 'string' ||
            typeof errand.headOid !== 'string' ||
            typeof errand.startedAt !== 'number'
        ) {
            return null;
        }
        return {
            ...errand,
            currentId: typeof errand.currentId === 'string' ? errand.currentId : errand.sessionId,
            finished: errand.finished ?? null,
            stoppedAt: typeof errand.stoppedAt === 'number' ? errand.stoppedAt : null,
        };
    } catch {
        return null;
    }
}

export class SqliteFixErrandStore implements FixErrandStore {
    private readonly allStatement;
    private readonly upsert;
    private readonly drop;

    constructor(
        db: Database.Database,
        private readonly now: () => number = Date.now,
    ) {
        this.allStatement = db.prepare<[], Row>('SELECT id, errand FROM fix_errands');
        this.upsert = db.prepare<[{id: string; landed_key: string; errand: string; updated_at: number}]>(`
      INSERT INTO fix_errands (id, landed_key, errand, updated_at)
      VALUES (@id, @landed_key, @errand, @updated_at)
      ON CONFLICT (id) DO UPDATE SET landed_key = excluded.landed_key, errand = excluded.errand,
        updated_at = excluded.updated_at
    `);
        this.drop = db.prepare<[string]>('DELETE FROM fix_errands WHERE id = ?');
    }

    public all(): FixErrand[] {
        return this.allStatement
            .all()
            .map(toErrand)
            .filter((errand): errand is FixErrand => errand !== null)
            .sort((a, b) => a.startedAt - b.startedAt);
    }

    public save(errand: FixErrand): void {
        this.upsert.run({
            id: errand.id,
            landed_key: errand.key,
            errand: JSON.stringify(errand),
            updated_at: this.now(),
        });
    }

    public remove(ids: readonly string[]): void {
        for (const id of ids) this.drop.run(id);
    }
}
