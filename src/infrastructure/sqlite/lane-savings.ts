/**
 * SQLite behind the LaneSavings port: the `lane_savings` table (#435), one
 * row per saving the Switchboard lane runner counted, summed by kind for the
 * Merge manager's "CI runs saved" estimate. Rows older than `KEPT_MS` are
 * dropped as new ones come in.
 */
import type Database from 'better-sqlite3';
import type {LaneSavings} from '../../application/ports/lane-savings';
import {LANE_SAVINGS, type LaneSaving} from '../../domain/merge-manager/model';

/** How long a saving is kept: past any week the page shows. */
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

export class SqliteLaneSavings implements LaneSavings {
    private readonly insert;
    private readonly prune;
    private readonly sums;
    private readonly sumsByRepository;

    constructor(db: Database.Database) {
        this.insert = db.prepare<[string, string, number, number]>(
            'INSERT INTO lane_savings (repository, kind, count, at) VALUES (?, ?, ?, ?)',
        );
        this.prune = db.prepare<[number]>('DELETE FROM lane_savings WHERE at < ?');
        this.sums = db.prepare<[number], {kind: string; total: number}>(
            'SELECT kind, SUM(count) AS total FROM lane_savings WHERE at >= ? GROUP BY kind',
        );
        this.sumsByRepository = db.prepare<[number], {repository: string; kind: string; total: number}>(
            'SELECT LOWER(repository) AS repository, kind, SUM(count) AS total FROM lane_savings WHERE at >= ? ' +
                'GROUP BY LOWER(repository), kind',
        );
    }

    public add(repository: string, kind: LaneSaving, count: number, at: number): void {
        if (!LANE_SAVINGS.includes(kind) || !Number.isSafeInteger(count) || count <= 0) return;
        this.insert.run(repository, kind, count, at);
        this.prune.run(at - KEPT_MS);
    }

    public since(at: number): Record<LaneSaving, number> {
        const totals = noSavings();
        for (const row of this.sums.all(at)) {
            if (isSaving(row.kind)) totals[row.kind] = row.total;
        }
        return totals;
    }

    public byRepository(at: number): Record<string, Record<LaneSaving, number>> {
        const repositories: Record<string, Record<LaneSaving, number>> = {};
        for (const row of this.sumsByRepository.all(at)) {
            if (!isSaving(row.kind)) continue;
            (repositories[row.repository] ??= noSavings())[row.kind] = row.total;
        }
        return repositories;
    }
}

function noSavings(): Record<LaneSaving, number> {
    return Object.fromEntries(LANE_SAVINGS.map((kind) => [kind, 0])) as Record<LaneSaving, number>;
}

function isSaving(kind: string): kind is LaneSaving {
    return (LANE_SAVINGS as readonly string[]).includes(kind);
}
