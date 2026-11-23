/**
 * SQLite behind the ScheduleRunStore port: the `schedule_runs` and
 * `schedule_prompt_versions` tables.
 *
 * Unlike the Merge manager's stores, a run is kept as columns rather than one
 * JSON value: the scheduler asks questions of them (is one running, was this
 * cron time run, what were the last fourteen) every minute and on every
 * change, and those are queries, not reads of everything.
 *
 * A run's place in time is its start, or, for one that never started, its
 * cron time, or when it was recorded; "newest first" orders by that.
 */
import type Database from 'better-sqlite3';
import type {ScheduleRunStore} from '../../application/ports/schedule-runs';
import type {PromptVersion, RunStatus, RunTrigger, ScheduleRun} from '../../domain/schedule/manager';

interface RunRow {
    id: string;
    schedule_key: string;
    session_id: string | null;
    trigger: string;
    due_at: number | null;
    started_at: number | null;
    ended_at: number | null;
    status: string;
    reason: string | null;
    prompt_version: number;
    report: string | null;
    week_before: number | null;
    week_after: number | null;
    worktree: string | null;
    seen: number;
}

interface VersionRow {
    version: number;
    text: string;
    saved_at: number;
    note: string | null;
}

const COLUMNS =
    'id, schedule_key, session_id, trigger, due_at, started_at, ended_at, status, reason, prompt_version, report, week_before, week_after, worktree, seen';
const NEWEST_FIRST = 'ORDER BY COALESCE(started_at, due_at, ended_at) DESC, rowid DESC';

/** Each field of a run and the column it is kept in. */
const COLUMN_OF: Record<keyof Omit<ScheduleRun, 'id' | 'scheduleKey'>, keyof RunRow> = {
    sessionId: 'session_id',
    trigger: 'trigger',
    dueAt: 'due_at',
    startedAt: 'started_at',
    endedAt: 'ended_at',
    status: 'status',
    reason: 'reason',
    promptVersion: 'prompt_version',
    report: 'report',
    weekBefore: 'week_before',
    weekAfter: 'week_after',
    worktree: 'worktree',
    seen: 'seen',
};

function toRun(row: RunRow): ScheduleRun {
    return {
        id: row.id,
        scheduleKey: row.schedule_key,
        sessionId: row.session_id,
        trigger: row.trigger as RunTrigger,
        dueAt: row.due_at,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        status: row.status as RunStatus,
        reason: row.reason,
        promptVersion: row.prompt_version,
        report: row.report,
        weekBefore: row.week_before,
        weekAfter: row.week_after,
        worktree: row.worktree,
        seen: row.seen === 1,
    };
}

function toRow(run: ScheduleRun): RunRow {
    return {
        id: run.id,
        schedule_key: run.scheduleKey,
        session_id: run.sessionId,
        trigger: run.trigger,
        due_at: run.dueAt,
        started_at: run.startedAt,
        ended_at: run.endedAt,
        status: run.status,
        reason: run.reason,
        prompt_version: run.promptVersion,
        report: run.report,
        week_before: run.weekBefore,
        week_after: run.weekAfter,
        worktree: run.worktree,
        seen: run.seen ? 1 : 0,
    };
}

export class SqliteScheduleRunStore implements ScheduleRunStore {
    private readonly insert;
    private readonly byId;
    private readonly ofKey;
    private readonly since;
    private readonly running;
    private readonly forDue;
    private readonly seeAll;
    private readonly versions;
    private readonly addVersion;
    private readonly rekeyTransaction;

    constructor(private readonly db: Database.Database) {
        this.insert = db.prepare<[RunRow]>(
            `INSERT INTO schedule_runs (${COLUMNS}) VALUES (@id, @schedule_key, @session_id, @trigger, @due_at,
        @started_at, @ended_at, @status, @reason, @prompt_version, @report, @week_before, @week_after, @worktree, @seen)`,
        );
        this.byId = db.prepare<[string], RunRow>(`SELECT ${COLUMNS} FROM schedule_runs WHERE id = ?`);
        this.ofKey = db.prepare<[string, number], RunRow>(
            `SELECT ${COLUMNS} FROM schedule_runs WHERE schedule_key = ? ${NEWEST_FIRST} LIMIT ?`,
        );
        this.since = db.prepare<[number, number, number], RunRow>(
            `SELECT ${COLUMNS} FROM schedule_runs WHERE started_at >= ? OR ended_at >= ? OR due_at >= ? ${NEWEST_FIRST}`,
        );
        this.running = db.prepare<[], RunRow>(
            `SELECT ${COLUMNS} FROM schedule_runs WHERE status = 'running' ${NEWEST_FIRST}`,
        );
        this.forDue = db.prepare<[string, number], {found: number}>(
            'SELECT 1 AS found FROM schedule_runs WHERE schedule_key = ? AND due_at = ? LIMIT 1',
        );
        this.seeAll = db.prepare("UPDATE schedule_runs SET seen = 1 WHERE seen = 0 AND status != 'running'");
        this.versions = db.prepare<[string], VersionRow>(
            'SELECT version, text, saved_at, note FROM schedule_prompt_versions WHERE schedule_key = ? ORDER BY version DESC',
        );
        this.addVersion = db.prepare<[string, number, string, number, string | null]>(
            'INSERT INTO schedule_prompt_versions (schedule_key, version, text, saved_at, note) VALUES (?, ?, ?, ?, ?)',
        );
        const moveRuns = db.prepare<[string, string]>(
            'UPDATE schedule_runs SET schedule_key = ? WHERE schedule_key = ?',
        );
        const dropVersions = db.prepare<[string]>('DELETE FROM schedule_prompt_versions WHERE schedule_key = ?');
        const moveVersions = db.prepare<[string, string]>(
            'UPDATE schedule_prompt_versions SET schedule_key = ? WHERE schedule_key = ?',
        );
        this.rekeyTransaction = db.transaction((from: string, to: string) => {
            moveRuns.run(to, from);
            // The versions follow the file; any the new path had (a file deleted there before) give way.
            if (this.versions.all(from).length > 0) dropVersions.run(to);
            moveVersions.run(to, from);
        });
    }

    public add(run: ScheduleRun): void {
        this.insert.run(toRow(run));
    }

    public update(id: string, change: Partial<Omit<ScheduleRun, 'id' | 'scheduleKey'>>): void {
        const sets: string[] = [];
        const values: Record<string, unknown> = {id};
        for (const [field, value] of Object.entries(change)) {
            const column = COLUMN_OF[field as keyof typeof COLUMN_OF];
            if (!column || value === undefined) continue;
            sets.push(`${column} = @${column}`);
            values[column] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
        }
        if (sets.length === 0) return;
        this.db.prepare(`UPDATE schedule_runs SET ${sets.join(', ')} WHERE id = @id`).run(values);
    }

    public get(id: string): ScheduleRun | null {
        const row = this.byId.get(id);
        return row ? toRun(row) : null;
    }

    public runsOf(scheduleKey: string, limit: number): ScheduleRun[] {
        return this.ofKey.all(scheduleKey, limit).map(toRun);
    }

    public runsSince(since: number): ScheduleRun[] {
        return this.since.all(since, since, since).map(toRun);
    }

    public runningRuns(): ScheduleRun[] {
        return this.running.all().map(toRun);
    }

    public hasRunFor(scheduleKey: string, dueAt: number): boolean {
        return this.forDue.get(scheduleKey, dueAt) !== undefined;
    }

    public markAllSeen(): number {
        return this.seeAll.run().changes;
    }

    public lastStatuses(scheduleKey: string, limit: number): RunStatus[] {
        return this.runsOf(scheduleKey, limit)
            .map((run) => run.status)
            .reverse();
    }

    public versionsOf(scheduleKey: string): PromptVersion[] {
        return this.versions
            .all(scheduleKey)
            .map((row) => ({version: row.version, text: row.text, savedAt: row.saved_at, note: row.note}));
    }

    public versionFor(scheduleKey: string, text: string, savedAt: number, note: string | null): number {
        const current = this.versions.get(scheduleKey);
        if (current && current.text === text) return current.version;
        const version = (current?.version ?? 0) + 1;
        this.addVersion.run(scheduleKey, version, text, savedAt, note);
        return version;
    }

    public rekey(from: string, to: string): void {
        if (from === to) return;
        this.rekeyTransaction(from, to);
    }
}
