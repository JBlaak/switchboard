/**
 * BlaakTasks, the user's task manager, as a dependency (#244, #252).
 *
 * Called from main only, at the URL in Settings, with the headers of the
 * `~/.claude.json` server that has that URL. No call ever throws: an empty
 * URL answers `off` without calling anything, and an outage answers
 * `unreachable`, so whoever asks can keep what it showed.
 */
import type {
  BlaakTasksResult, TaskDetail, TaskListOptions, TaskPatch, TaskRow, TaskView,
} from '../../domain/tasks/model';

export interface BlaakTasks {
  /** The tasks in `view`, or matching `options.query`. */
  list(view: TaskView, options?: TaskListOptions): Promise<BlaakTasksResult<TaskRow[]>>;
  /** One task in full: its brief, progress log and Notion page. */
  get(id: string): Promise<BlaakTasksResult<TaskDetail>>;
  /** Change one task; answers the row as it is now. */
  update(id: string, patch: TaskPatch): Promise<BlaakTasksResult<TaskRow>>;
  /** Log a progress line, with the pull request it is about if any; answers the row as it is now. */
  progress(id: string, text: string, pullRequest?: string): Promise<BlaakTasksResult<TaskRow>>;
}
