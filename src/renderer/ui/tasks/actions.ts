/**
 * What the task surfaces do with sessions (#248): start one on a task.
 *
 * The Tasks page (#249), the session's task (#250) and the project page's
 * Tasks section (#251) build their own actions next to this one.
 */
import { startClaudeSessionIn } from '../../features/sessions/session-actions';
import { resolveDefaultSessionOptions } from '../../features/dialogs/launch-options';
import { startTaskSessionWith, type StartTaskSessionRequest, type StartTaskSessionSteps } from './start-task-session';
import type { TaskSessionStart } from '../../../domain/tasks/surface';

/**
 * Start a session on a task: a worktree on a branch named after it, in the
 * project asked for, else the task's repo, else the one Ask Patch picks;
 * Claude started there with the project's usual options and BlaakTasks'
 * handoff; then linked to the task, which goes In progress and ★.
 *
 * Answers the new session (with a warning when it started but not as asked),
 * or what stopped it: the branch exists already (ask again with `existing`),
 * Patch is unsure (ask again with a `projectPath`), no match, off, or failed.
 */
export function startTaskSession(request: StartTaskSessionRequest): Promise<TaskSessionStart> {
  return startTaskSessionWith(taskSessionSteps, request);
}

/** The real steps: main prepares the worktree and links the session, the renderer starts it. */
export const taskSessionSteps: StartTaskSessionSteps = {
  prepare: (request) => window.api.prepareTaskStart(request),
  defaultOptions: resolveDefaultSessionOptions,
  launch: (projectPath, options, how) => startClaudeSessionIn(projectPath, options, how),
  started: (taskId, sessionId, projectPath) => window.api.taskSessionStarted(taskId, sessionId, projectPath),
};
