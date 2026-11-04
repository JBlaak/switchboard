/**
 * SQLite behind the QueueErrandStore port: the `queue_errands` table, one row
 * per Nudge or Fix in session (#315).
 */
import type Database from 'better-sqlite3';
import type {QueueErrandStore} from '../../application/ports/queue-errand-store';
import type {QueueErrand} from '../../domain/project/queue-errands';

interface Row {
    id: string;
    kind: string;
    repository: string;
    number: number;
    title: string;
    url: string;
    reviewer: string | null;
    message: string | null;
    session_id: string | null;
    created_at: number;
    settled_at: number | null;
}

const COLUMNS = 'id, kind, repository, number, title, url, reviewer, message, session_id, created_at, settled_at';

function toErrand(row: Row): QueueErrand {
    return {
        id: row.id,
        // Anything another build wrote reads as a fix: it never blocks a nudge.
        kind: row.kind === 'nudge' ? 'nudge' : 'fix',
        repository: row.repository,
        number: row.number,
        title: row.title,
        url: row.url,
        reviewer: row.reviewer,
        message: row.message,
        sessionId: row.session_id,
        createdAt: row.created_at,
        settledAt: row.settled_at,
    };
}

export class SqliteQueueErrandStore implements QueueErrandStore {
    private readonly addStatement;
    private readonly setSessionStatement;
    private readonly settleStatement;
    private readonly removeStatement;
    private readonly allStatement;

    constructor(db: Database.Database) {
        this.addStatement = db.prepare<[Row]>(
            `INSERT OR REPLACE INTO queue_errands (${COLUMNS}) VALUES ` +
                '(@id, @kind, @repository, @number, @title, @url, @reviewer, @message, @session_id, @created_at, @settled_at)',
        );
        this.setSessionStatement = db.prepare<[string, string]>('UPDATE queue_errands SET session_id = ? WHERE id = ?');
        this.settleStatement = db.prepare<[number, string]>('UPDATE queue_errands SET settled_at = ? WHERE id = ?');
        this.removeStatement = db.prepare<[string]>('DELETE FROM queue_errands WHERE id = ?');
        this.allStatement = db.prepare<[], Row>(`SELECT ${COLUMNS} FROM queue_errands ORDER BY created_at, rowid`);
    }

    public add(errand: QueueErrand): void {
        this.addStatement.run({
            id: errand.id,
            kind: errand.kind,
            repository: errand.repository,
            number: errand.number,
            title: errand.title,
            url: errand.url,
            reviewer: errand.reviewer,
            message: errand.message,
            session_id: errand.sessionId,
            created_at: errand.createdAt,
            settled_at: errand.settledAt,
        });
    }

    public setSession(id: string, sessionId: string): void {
        this.setSessionStatement.run(sessionId, id);
    }

    public settle(id: string, at: number): void {
        this.settleStatement.run(at, id);
    }

    public remove(id: string): void {
        this.removeStatement.run(id);
    }

    public all(): QueueErrand[] {
        return this.allStatement.all().map(toErrand);
    }
}
