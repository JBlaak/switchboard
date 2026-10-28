/**
 * Where task links are kept (#245): which session works on which BlaakTasks
 * task, and a task's repo set by hand.
 *
 * The store keeps a session to one link, so `link` replaces whatever the
 * session had, and a task to one repo set by hand. Which link decides a task's
 * repo or owner is the domain's to say (`domain/tasks/links`), not the store's.
 */
import type { TaskLink } from '../../domain/tasks/links';

/** A link that names its session. */
export type SessionTaskLink = TaskLink & { sessionId: string };

export interface TaskLinkStore {
  /** Every link, oldest first. */
  all(): TaskLink[];
  /** A task's links, its repo set by hand included, oldest first. */
  forTask(taskId: string): TaskLink[];
  /** The session's link, or null when it has none. */
  forSession(sessionId: string): TaskLink | null;
  /** Links the session, replacing any link it had. */
  link(link: SessionTaskLink): void;
  /** Drops the session's link, if it has one. */
  unlink(sessionId: string): void;
  /** Sets a task's repo by hand: a link without a session, replacing an earlier one. */
  setRepo(taskId: string, projectPath: string, at: number): void;
}
