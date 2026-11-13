/**
 * The Planner as an external system (#412): which cycle a day falls in.
 *
 * Never rejects. A Planner that is down, slow, answers an error or answers
 * without the dates comes back as null, which hides the cycle snoozes. A
 * snooze menu waits on this, so an implementation gives up within 5 seconds.
 */
import type {Cycle} from '../../domain/inbox/cycle';

export interface CycleProvider {
    /** The cycle `day` (YYYY-MM-DD) falls in, as the Planner at `plannerUrl` says; null when it could not say. */
    cycleOn(plannerUrl: string, day: string): Promise<Cycle | null>;
}
