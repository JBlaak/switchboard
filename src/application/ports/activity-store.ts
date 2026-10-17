/**
 * The Session work actions, kept across restarts.
 *
 * A queued action waits for its session to go idle (A2), and that can be
 * after Switchboard was quit and opened again; so the queue is stored, not
 * held in memory. Each row is one action on one work item: the prompt as it
 * was rendered when it was asked for, and when it was queued, typed in and
 * finished.
 */
import type { Activity, WorkAction } from '../../domain/session-work/model';

export interface StoredAction {
  id: string;
  /** The session it is typed into, by the id it had when it was asked for. */
  sessionId: string;
  /** `owner/repo`, '' when the session's repository is not on GitHub. */
  repository: string;
  /** The work item it acts on (`workItemKey`). */
  itemKey: string;
  action: WorkAction;
  origin: Activity['origin'];
  phase: Activity['phase'];
  prompt: string;
  /** ISO-8601. */
  queuedAt: string;
  sentAt: string | null;
  doneAt: string | null;
  /** What the card says beyond the phase: an auto-fix's attempt, or the attempts it gave up after. */
  details?: ActivityDetails | null;
}

/** The parts of an `Activity` only some actions have. */
export type ActivityDetails = Pick<Activity, 'attempt' | 'checkName' | 'attempts'>;

export interface ActivityStore {
  add(action: StoredAction): void;

  /** Change how far an action got. Unknown ids are ignored. */
  update(id: string, changes: Partial<Pick<StoredAction, 'phase' | 'sentAt' | 'doneAt'>>): void;

  /** Forget an action that was never typed in (a cancelled one). */
  remove(id: string): void;

  /** Every action that is not done, oldest first: the queues as they were left. */
  unfinished(): StoredAction[];
}
