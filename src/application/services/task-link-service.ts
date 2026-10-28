/**
 * Which session works on which BlaakTasks task, and in which repo (#245).
 *
 * Links come from three places: a session started from a task, a session's
 * own `blaaktasks` update or progress call (`scan`), and a link made by hand.
 * The rules that read them — a task's repo, its owner, a session's one task —
 * live in `domain/tasks/links`; this keeps them, stamps them with the time,
 * and knows which sessions are still active.
 */
import { detectTask } from '../../domain/tasks/detect';
import {
  detectedLinkWins, repoTasks, taskIdFrom, taskOwner, taskRepo, taskSessions,
  type TaskLink, type TaskLinkSource,
} from '../../domain/tasks/links';
import type { Clock } from '../ports/clock';
import type { TaskLinkStore } from '../ports/task-link-store';

/** A session as ownership sees it. */
export interface TaskLinkSession {
  sessionId: string;
  /** Epoch ms of its last activity. */
  activeAt: number;
  /** Archived: it owns no task, though it stays linked. */
  archived?: boolean;
}

export interface TaskLinkServiceDeps {
  store: TaskLinkStore;
  /** Every listed session and every running one, as the Plan tab's ownership has them. */
  sessions(): TaskLinkSession[];
  clock: Clock;
}

export class TaskLinkService {
  constructor(private readonly deps: TaskLinkServiceDeps) {}

  /**
   * Links a session to a task, replacing any task it had, and answers the
   * link. Throws on a task id that cannot be a Notion page id.
   */
  link(taskId: string, sessionId: string, projectPath: string, source: TaskLinkSource): TaskLink {
    const id = taskIdFrom(taskId);
    if (!id) throw new Error(`Not a task id: ${taskId}`);
    const link = { taskId: id, projectPath, sessionId, source, linkedAt: this.deps.clock.now() };
    this.deps.store.link(link);
    return link;
  }

  /** The session no longer works on a task, until it names one again after now. */
  unlink(sessionId: string): void {
    this.deps.store.unlink(sessionId, this.deps.clock.now());
  }

  /** The task the session works on, or null. */
  taskOf(sessionId: string): string | null {
    return this.deps.store.forSession(sessionId)?.taskId ?? null;
  }

  /** Where the task's work happens: its latest link's project, or null when it has none. */
  repoOf(taskId: string): string | null {
    const id = taskIdFrom(taskId);
    return id ? taskRepo(this.deps.store.forTask(id), id) : null;
  }

  /** The sessions that work on the task, the most recently linked first. */
  sessionsOf(taskId: string): string[] {
    const id = taskIdFrom(taskId);
    return id ? taskSessions(this.deps.store.forTask(id), id) : [];
  }

  /**
   * The task's most recently active session, or null when none of its sessions
   * can own it. A linked session not listed yet (just started) counts as
   * active from the moment it was linked; an archived one owns nothing.
   */
  ownerOf(taskId: string): string | null {
    const id = taskIdFrom(taskId);
    if (!id) return null;
    const links = this.deps.store.forTask(id);
    const sessions = new Map(this.deps.sessions().map((session) => [session.sessionId, session]));
    return taskOwner(links, id, (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return links.find((link) => link.sessionId === sessionId)?.linkedAt ?? null;
      return session.archived ? null : session.activeAt;
    });
  }

  /** The tasks whose repo is this project, the most recently linked first. */
  tasksIn(projectPath: string): string[] {
    return repoTasks(this.deps.store.all(), projectPath);
  }

  /** Moves the task to another repo by hand, until a newer link moves it again. */
  setRepo(taskId: string, projectPath: string): void {
    const id = taskIdFrom(taskId);
    if (!id) throw new Error(`Not a task id: ${taskId}`);
    this.deps.store.setRepo(id, projectPath, this.deps.clock.now());
  }

  /**
   * Reads a session's transcript for the task it says it works on, and links it
   * when that is news: no link yet, or a different task named after the link
   * was made. A session unlinked by hand is relinked only by a call made
   * after the unlink. Answers the new link, or null when nothing changed.
   */
  scan(sessionId: string, transcript: readonly string[], projectPath: string): TaskLink | null {
    const detected = detectTask(transcript);
    if (!detected) return null;
    const { store } = this.deps;
    if (!detectedLinkWins(store.forSession(sessionId), detected, store.unlinkedAt(sessionId))) return null;
    return this.link(detected.taskId, sessionId, projectPath, 'detected');
  }
}
