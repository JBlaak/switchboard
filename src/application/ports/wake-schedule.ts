/**
 * The Mac's repeating wake (`pmset repeat`), for the Schedule manager: a
 * schedule that runs at 03:00 only runs when the Mac is awake then.
 */
import type {ScheduleActionResult} from '../../domain/schedule/manager';

export interface WakeSchedule {
    /** The repeating wake as `HH:MM`, or null when none is set or it cannot be read (not a Mac). */
    read(): Promise<string | null>;
    /**
     * Wake the Mac at `at` (`HH:MM`) every day, or (null) stop waking it.
     * Asks for an administrator password; answers `{error}` when the user
     * cancels the prompt or the change fails.
     */
    set(at: string | null): Promise<ScheduleActionResult>;
}
