/**
 * SQLite behind the AutoFixHistory port: the `auto_fix_attempts` table.
 *
 * Append-only, read per PR in the order it was written, which is the order
 * the auto-fix rule reads it in.
 */
import type Database from 'better-sqlite3';
import type {AutoFixHistory, AutoFixRecord} from '../../application/ports/auto-fix-history';

interface Row {
    kind: AutoFixRecord['kind'];
    repository: string;
    number: number;
    check_name: string;
    head_sha: string;
    origin: 'manual' | 'auto' | null;
    activity_id: string | null;
    at: string;
}

export class SqliteAutoFixHistory implements AutoFixHistory {
    private readonly insertStatement;
    private readonly forPullRequestStatement;

    constructor(db: Database.Database) {
        this.insertStatement = db.prepare<[Row]>(`
      INSERT INTO auto_fix_attempts (kind, repository, number, check_name, head_sha, origin, activity_id, at)
      VALUES (@kind, @repository, @number, @check_name, @head_sha, @origin, @activity_id, @at)
    `);
        this.forPullRequestStatement = db.prepare<[string, number], Row>(
            'SELECT * FROM auto_fix_attempts WHERE repository = ? AND number = ? ORDER BY id',
        );
    }

    public record(event: AutoFixRecord): void {
        const attempt = event.kind === 'attempt' ? event : null;
        this.insertStatement.run({
            kind: event.kind,
            repository: event.repository,
            number: event.number,
            check_name: event.checkName,
            head_sha: attempt?.headSha ?? '',
            origin: attempt?.origin ?? null,
            activity_id: attempt?.activityId ?? null,
            at: event.at,
        });
    }

    public forPullRequest(repository: string, number: number): AutoFixRecord[] {
        return this.forPullRequestStatement.all(repository, number).map((row): AutoFixRecord => {
            const base = {repository: row.repository, number: row.number, checkName: row.check_name, at: row.at};
            if (row.kind === 'attempt') {
                return {
                    ...base,
                    kind: 'attempt',
                    headSha: row.head_sha,
                    origin: row.origin ?? 'auto',
                    activityId: row.activity_id ?? '',
                };
            }
            return {...base, kind: row.kind};
        });
    }
}
