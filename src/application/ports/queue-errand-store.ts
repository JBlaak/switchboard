/**
 * The merge queue's errands (#315), kept across restarts: which sessions were
 * started by Nudge or Fix in session, for which PR, and which nudges still
 * stand, so a restart neither forgets a session is an errand nor lets a
 * reviewer be nudged twice about one review request.
 */
import type {QueueErrand} from '../../domain/project/queue-errands';

export interface QueueErrandStore {
    add(errand: QueueErrand): void;
    /** The renderer started the errand's session. Unknown ids are ignored. */
    setSession(id: string, sessionId: string): void;
    /** A nudge's review request changed (epoch ms). Unknown ids are ignored. */
    settle(id: string, at: number): void;
    /** Forget an errand: one whose session never started, or one old enough to drop. */
    remove(id: string): void;
    /** Every errand, oldest first. */
    all(): QueueErrand[];
}
