/**
 * Where the Schedule manager keeps what a schedule file cannot: its runs and
 * the versions of its prompt. Keyed by the schedule's key (its file's
 * absolute path).
 */
import type {PromptVersion, RunStatus, ScheduleRun} from '../../domain/schedule/manager';

export interface ScheduleRunStore {
    /** A new run, as it starts (or as it is recorded skipped or missed). */
    add(run: ScheduleRun): void;
    /** Change a run: as it ends, when its session is known, when it is seen. */
    update(id: string, change: Partial<Omit<ScheduleRun, 'id' | 'scheduleKey'>>): void;
    get(id: string): ScheduleRun | null;
    /** One schedule's runs, newest first. */
    runsOf(scheduleKey: string, limit: number): ScheduleRun[];
    /** Every schedule's runs that started, ended or were due at or after `since`, newest first. */
    runsSince(since: number): ScheduleRun[];
    /** Runs left `running` by a Switchboard that quit or crashed mid-run. */
    runningRuns(): ScheduleRun[];
    /** Whether a run (of any status) was recorded for this cron time. */
    hasRunFor(scheduleKey: string, dueAt: number): boolean;
    /** Mark every finished, unseen run seen; answers how many. */
    markAllSeen(): number;
    /** Statuses of the newest `limit` runs, oldest first. */
    lastStatuses(scheduleKey: string, limit: number): RunStatus[];

    /** The prompt's versions, newest first. */
    versionsOf(scheduleKey: string): PromptVersion[];
    /**
     * The version this prompt text is: the current one when it is unchanged,
     * else a new version recorded with `note` (the first ever is version 1).
     */
    versionFor(scheduleKey: string, text: string, savedAt: number, note: string | null): number;
    /** A schedule file renamed or moved: its runs and versions follow it. */
    rekey(from: string, to: string): void;
}
