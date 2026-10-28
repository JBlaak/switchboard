/**
 * Everything Switchboard writes to a BlaakTasks task on its own (#247).
 *
 * Only for a session linked to a task (`TaskLinkService`), and only what it
 * knows for certain:
 *
 * - a session started from the task: In progress, starred for today;
 * - each PR the session opens: an "Opened PR #n" line carrying the PR;
 * - the archive: a "Session archived" line, and whether to offer Mark done;
 * - Mark done, when you press it: the only way a task becomes Done.
 *
 * Every write goes through one queue, in order. One that cannot get through
 * (BlaakTasks unreachable, or it said no) stays at the head and is sent again
 * by `retry()` on the next poll; nothing after it overtakes it, so a task
 * never ends up In progress after Done. Nothing here throws back to the caller.
 */
import {
  DONE_PATCH, SESSION_ARCHIVED_LINE, STARTED_PATCH, offersMarkDone, openedPullRequestLine,
  type PullRequestState, type TaskWrite,
} from '../../domain/tasks/writes';
import { taskIdFrom } from '../../domain/tasks/links';
import type { BlaakTasksResult } from '../../domain/tasks/model';
import type { SessionPullRequest } from '../../domain/session/session';
import type { BlaakTasks } from '../ports/blaak-tasks';
import type { Logger } from '../ports/logger';
import type { TaskLinkService } from './task-link-service';

/** How many times BlaakTasks may refuse one write before it is given up on. */
export const MAX_REFUSED_ATTEMPTS = 3;

/**
 * How a write ended, as far as the caller waited for it.
 *
 * - `sent`: BlaakTasks took it.
 * - `queued`: it did not get through yet; `retry()` sends it again.
 * - `dropped`: BlaakTasks is off or not set up, or refused it too often.
 * - `skipped`: nothing to write: the session has no task, or the PR was already written.
 */
export type TaskWriteOutcome = 'sent' | 'queued' | 'dropped' | 'skipped';

export interface TaskWritesServiceDeps {
  tasks: Pick<BlaakTasks, 'update' | 'progress'>;
  links: Pick<TaskLinkService, 'taskOf'>;
  /** The PRs a session opened, from its transcript's `pr-link` lines. */
  pullRequests(sessionId: string): readonly SessionPullRequest[];
  /** A PR's state as `PrWatchService` last heard it; null when it never did. */
  pullRequestState(url: string): PullRequestState | null;
  log: Logger;
}

interface Queued {
  write: TaskWrite;
  /** Times BlaakTasks answered `failed`. */
  refused: number;
  outcome: TaskWriteOutcome;
}

export class TaskWritesService {
  readonly #queue: Queued[] = [];
  /** The PRs already written, as `taskId url`: each goes on its task once. */
  readonly #written = new Set<string>();
  /** The drain running now, or the last one; drains never overlap. */
  #draining: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TaskWritesServiceDeps) {}

  /** A session started from its task: In progress, and starred for today. */
  sessionStarted(sessionId: string): Promise<TaskWriteOutcome> {
    const taskId = this.deps.links.taskOf(sessionId);
    if (!taskId) return Promise.resolve('skipped');
    return this.#send({ kind: 'update', taskId, patch: { ...STARTED_PATCH } });
  }

  /** The session opened (or linked) a PR: one "Opened PR #n" line for it, ever. */
  pullRequestOpened(sessionId: string, pr: SessionPullRequest): Promise<TaskWriteOutcome> {
    const taskId = this.deps.links.taskOf(sessionId);
    if (!taskId) return Promise.resolve('skipped');
    const key = `${taskId} ${pr.url}`;
    if (this.#written.has(key)) return Promise.resolve('skipped');
    this.#written.add(key);
    return this.#send({ kind: 'progress', taskId, text: openedPullRequestLine(pr), pullRequest: pr.url });
  }

  /**
   * The session was archived: a "Session archived" line on its task, sent in
   * the background so the archive never waits on BlaakTasks. Answers whether
   * to offer Mark done: only when you archived it and every PR it opened is
   * merged. A session that has no task is offered nothing.
   */
  async sessionArchived(sessionId: string, archive: { byUser: boolean }): Promise<boolean> {
    const taskId = this.deps.links.taskOf(sessionId);
    if (!taskId) return false;
    void this.#send({ kind: 'progress', taskId, text: SESSION_ARCHIVED_LINE });
    try {
      return offersMarkDone(archive, this.deps.pullRequests(sessionId), (url) => this.deps.pullRequestState(url));
    } catch (err) {
      this.deps.log.error('[task-writes] reading the PRs of an archived session failed:', (err as Error).message);
      return false;
    }
  }

  /** You pressed Mark done: the task is Done. The only write that sets it. */
  markDone(taskId: string): Promise<TaskWriteOutcome> {
    const id = taskIdFrom(taskId);
    if (!id) return Promise.resolve('skipped');
    return this.#send({ kind: 'update', taskId: id, patch: { ...DONE_PATCH } });
  }

  /** Send what did not get through, in order: on the next poll. */
  retry(): Promise<void> {
    return this.#drain();
  }

  /** The writes still waiting to get through, oldest first. */
  pending(): TaskWrite[] {
    return this.#queue.map((entry) => entry.write);
  }

  async #send(write: TaskWrite): Promise<TaskWriteOutcome> {
    const entry: Queued = { write, refused: 0, outcome: 'queued' };
    this.#queue.push(entry);
    await this.#drain();
    return entry.outcome;
  }

  #drain(): Promise<void> {
    this.#draining = this.#draining.then(() => this.#sendQueued());
    return this.#draining;
  }

  /** Send from the head of the queue until it is empty or a write does not get through. */
  async #sendQueued(): Promise<void> {
    while (this.#queue.length > 0) {
      const entry = this.#queue[0];
      const result = await this.#call(entry.write);
      if (result.kind === 'ok') {
        entry.outcome = 'sent';
      } else if (result.kind === 'off' || result.kind === 'notSetUp') {
        // Nowhere to send it: BlaakTasks is not on, so there is nothing to catch up on.
        entry.outcome = 'dropped';
      } else if (result.kind === 'failed' && ++entry.refused >= MAX_REFUSED_ATTEMPTS) {
        this.deps.log.warn(`[task-writes] gave up on ${describe(entry.write)}: ${result.reason}`);
        entry.outcome = 'dropped';
      } else {
        this.deps.log.info(`[task-writes] ${describe(entry.write)} queued: ${result.reason}`);
        return;
      }
      this.#queue.shift();
    }
  }

  async #call(write: TaskWrite): Promise<BlaakTasksResult<unknown>> {
    try {
      return write.kind === 'update'
        ? await this.deps.tasks.update(write.taskId, write.patch)
        : await this.deps.tasks.progress(write.taskId, write.text, write.pullRequest);
    } catch (err) {
      // The port never throws; should one ever, it is an outage like any other.
      return { kind: 'unreachable', reason: (err as Error).message };
    }
  }
}

function describe(write: TaskWrite): string {
  return write.kind === 'update'
    ? `update ${write.taskId} ${JSON.stringify(write.patch)}`
    : `progress ${write.taskId} "${write.text}"`;
}
