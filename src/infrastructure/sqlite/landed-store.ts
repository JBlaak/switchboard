/**
 * SQLite behind the LandedStore port: the `landed_pull_requests` table (#434).
 *
 * A landed PR is kept as JSON, read and written whole, like `inbox_items`:
 * the Merge manager reads all of it at launch and writes what a poll or an
 * action changed. A row that does not parse as a landed PR (another build's,
 * or a damaged one) is skipped rather than failing the launch.
 */
import type Database from 'better-sqlite3';
import type {LandedStore} from '../../application/ports/landed-store';
import type {LandedPullRequest} from '../../domain/merge-manager/model';

interface Row {
    key: string;
    pull_request: string;
}

const STAGES: readonly string[] = ['waiting', 'held', 'head', 'fixing', 'needsYou', 'merged'];

function toLanded(row: Row): LandedPullRequest | null {
    try {
        const pr = JSON.parse(row.pull_request) as LandedPullRequest;
        if (
            pr?.key !== row.key ||
            typeof pr.repository !== 'string' ||
            typeof pr.number !== 'number' ||
            typeof pr.landedAt !== 'number' ||
            (pr.lane !== 'queue' && pr.lane !== 'switchboard') ||
            !STAGES.includes(pr.stage?.kind)
        ) {
            return null;
        }
        return {...pr, setAside: pr.setAside ?? null, errand: typeof pr.errand === 'string' ? pr.errand : null};
    } catch {
        return null;
    }
}

export class SqliteLandedStore implements LandedStore {
    private readonly allStatement;
    private readonly applyTransaction;

    constructor(db: Database.Database, now: () => number = Date.now) {
        this.allStatement = db.prepare<[], Row>('SELECT key, pull_request FROM landed_pull_requests ORDER BY key');
        const upsert = db.prepare<[{key: string; repository: string; pull_request: string; updated_at: number}]>(`
      INSERT INTO landed_pull_requests (key, repository, pull_request, updated_at)
      VALUES (@key, @repository, @pull_request, @updated_at)
      ON CONFLICT (key) DO UPDATE SET repository = excluded.repository, pull_request = excluded.pull_request,
        updated_at = excluded.updated_at
    `);
        const drop = db.prepare<[string]>('DELETE FROM landed_pull_requests WHERE key = ?');
        this.applyTransaction = db.transaction((save: readonly LandedPullRequest[], remove: readonly string[]) => {
            const at = now();
            for (const pr of save) {
                upsert.run({
                    key: pr.key,
                    repository: pr.repository,
                    pull_request: JSON.stringify(pr),
                    updated_at: at,
                });
            }
            for (const key of remove) drop.run(key);
        });
    }

    public all(): LandedPullRequest[] {
        return this.allStatement
            .all()
            .map(toLanded)
            .filter((pr): pr is LandedPullRequest => pr !== null);
    }

    public apply(save: readonly LandedPullRequest[], remove: readonly string[]): void {
        if (save.length === 0 && remove.length === 0) return;
        this.applyTransaction(save, remove);
    }
}
