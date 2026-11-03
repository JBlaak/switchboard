/**
 * SQLite behind the VmTranscriptStore port: the `vm_transcripts` table.
 *
 * Its own table rather than rows in `session_cache`: that cache is a copy of
 * the transcripts on the Mac's disk, every reader of it lists those rows as
 * local sessions, and the re-index drops whatever it cannot find on disk. A VM
 * session's transcript is none of those things. The parsed transcript is kept
 * as JSON: it is read and written whole, never queried by field.
 */
import type Database from 'better-sqlite3';
import type {VmTranscriptEntry, VmTranscriptStore} from '../../application/ports/vm-transcript-store';
import type {CachedSession} from '../../domain/session/session';

interface Row {
    session_id: string;
    host_key: string;
    cwd: string;
    mtime_ms: number;
    transcript: string;
}

export class SqliteVmTranscriptStore implements VmTranscriptStore {
    private readonly allStatement;
    private readonly putStatement;
    private readonly deleteStatement;

    constructor(db: Database.Database) {
        this.allStatement = db.prepare<[], Row>(
            'SELECT session_id, host_key, cwd, mtime_ms, transcript FROM vm_transcripts',
        );
        this.putStatement = db.prepare<[Row]>(`
      INSERT INTO vm_transcripts (session_id, host_key, cwd, mtime_ms, transcript)
      VALUES (@session_id, @host_key, @cwd, @mtime_ms, @transcript)
      ON CONFLICT (session_id) DO UPDATE SET
        host_key = excluded.host_key, cwd = excluded.cwd,
        mtime_ms = excluded.mtime_ms, transcript = excluded.transcript
    `);
        this.deleteStatement = db.prepare<[string]>('DELETE FROM vm_transcripts WHERE session_id = ?');
    }

    public all(): VmTranscriptEntry[] {
        const entries: VmTranscriptEntry[] = [];
        for (const row of this.allStatement.all()) {
            try {
                entries.push({
                    sessionId: row.session_id,
                    hostKey: row.host_key,
                    cwd: row.cwd,
                    mtimeMs: row.mtime_ms,
                    transcript: JSON.parse(row.transcript) as CachedSession,
                });
            } catch {
                // A row another build wrote and this one cannot read: fetched again on the next connect.
            }
        }
        return entries;
    }

    public put(entry: VmTranscriptEntry): void {
        this.putStatement.run({
            session_id: entry.sessionId,
            host_key: entry.hostKey,
            cwd: entry.cwd,
            mtime_ms: entry.mtimeMs,
            transcript: JSON.stringify(entry.transcript),
        });
    }

    public delete(sessionId: string): void {
        this.deleteStatement.run(sessionId);
    }
}
