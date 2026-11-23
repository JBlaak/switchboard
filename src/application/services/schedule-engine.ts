/**
 * The seam between the scheduler (`ScheduleService`, which finds schedule
 * files, ticks and runs them) and the Schedule manager's service (which
 * builds the page's facts, saves files, drafts, sets the wake).
 */
import type {RunTrigger, ScheduleActionResult, ScheduleRunsOn, ScheduleSettings} from '../../domain/schedule/manager';

/** One schedule file as the scheduler sees it, on or off. */
export interface ScheduleEntry {
    /** The file's absolute path. */
    readonly key: string;
    readonly settings: ScheduleSettings;
    readonly runsOn: ScheduleRunsOn;
    /**
     * Never saved or turned on from Switchboard (no prompt version recorded):
     * written by the slash command or by hand. The scheduler does not run it
     * until it is turned on from the Schedule manager.
     */
    readonly isNew: boolean;
}

export interface ScheduleEngine {
    /** Every schedule file in every known project, on or off, new or not. */
    all(): ScheduleEntry[];
    /** Start a run now, whatever the time and whether it is on. */
    runNow(key: string, trigger: Extract<RunTrigger, 'manual' | 'try'>): ScheduleActionResult;
    /** Skip the next cron time: it is recorded as a skipped run when it comes. */
    skipNext(key: string): ScheduleActionResult;
    /** Whether a run of it is going now. */
    isRunning(key: string): boolean;
    /** Called after any run starts, ends or is recorded; answers the unsubscribe. */
    onChanged(cb: () => void): () => void;
}
