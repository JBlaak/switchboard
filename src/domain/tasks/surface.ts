/**
 * What the renderer's task surfaces ask main and are told (#248): the Tasks
 * page (#249), the session's task (#250) and the project page's Tasks section
 * (#251). The shapes cross IPC, so they are plain data.
 */
import type { ExistingBranchChoice } from '../project/branch-worktree';
import type { BlaakTasksResult, TaskListOptions, TaskRow, TaskView } from './model';
import type { TaskSessionPreparation, TaskStartInput } from './start';

/** A list to show: a view, or a search when `options.query` is set. */
export interface TaskQuery {
  view: TaskView;
  options?: TaskListOptions;
}

/**
 * How a watched list stands after a poll, pushed as `tasksChanged`.
 *
 * - `ok`: `rows` are fresh.
 * - `unreachable`: BlaakTasks did not answer; `rows` are the last ones it
 *   sent, kept so the list stays on screen ("Couldn't reach BlaakTasks ·
 *   retrying"), and it is asked again on the next poll.
 * - `failed`: BlaakTasks answered no (`reason`); `rows` are kept as for `unreachable`.
 * - `off`: no BlaakTasks URL is set; `rows` is empty.
 * - `notSetUp`: the URL is set but no server in `~/.claude.json` has it; `rows` is empty.
 */
export interface TasksUpdate {
  /** The id the surface watched it under. */
  watchId: string;
  query: TaskQuery;
  state: 'ok' | 'unreachable' | 'failed' | 'off' | 'notSetUp';
  rows: TaskRow[];
  /** Why it is not `ok`, for `unreachable` and `failed`. */
  reason?: string;
  /** Epoch ms of the last `ok` answer the rows are from; null before the first. */
  fetchedAt: number | null;
}

/** A change to a task from a row key or its detail: ★, snooze, or Done. */
export type TaskChange =
  | { kind: 'star'; today: boolean }
  /** A `YYYY-MM-DD` (or local datetime) to snooze until, or null to wake it. */
  | { kind: 'snooze'; until: string | null }
  /** Only ever sent because you pressed for it. */
  | { kind: 'done' };

/**
 * How a change ended: the row as it is now (null for Done, whose answer comes
 * with the next poll), `queued` when Done did not get through yet and is sent
 * again on the next poll, or BlaakTasks' own answer.
 */
export type TaskUpdateResult = BlaakTasksResult<TaskRow | null> | { kind: 'queued' };

/** What starting a session on a task asks main to prepare. */
export interface TaskStartRequest {
  task: TaskStartInput;
  /** The project to start in: skips the task's linked repo and Ask Patch. */
  projectPath?: string;
  /** What to do with the task's branch when it exists already; without it, the refusal. */
  existing?: ExistingBranchChoice;
}

/** What preparing a start answers: the domain's preparation, or `off` while BlaakTasks is. */
export type TaskStartPreparation = TaskSessionPreparation | { kind: 'off' };

/**
 * How a start from a task ended, as the renderer's start helper answers it:
 * the new session (its project is the repository's main checkout, which the
 * task is now linked to), or anything but `ready` that preparing answered
 * (the existing branch, Ask Patch unsure, no match, failed, cancelled, off).
 */
export type TaskSessionStart =
  | { kind: 'started'; sessionId: string; projectPath: string; warning?: string }
  | Exclude<TaskStartPreparation, { kind: 'ready' }>;

/** A task's sessions, the most recently linked first, and the one that owns it. */
export interface TaskSessions {
  sessions: string[];
  owner: string | null;
}

/** Archiving a session of a task whose PRs are all merged offers this (only when you archived it). */
export interface MarkDoneOffer {
  taskId: string;
}
