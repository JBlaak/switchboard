/**
 * Starting a session from a BlaakTasks task (#248), from the renderer's side.
 *
 * As an issue start does (`startIssueSessionWith`): main makes the worktree
 * and the prompt (`prepareTaskStart`), and the session is started here,
 * because its row is the renderer's to make. It starts with the project's
 * usual session options, minus `--worktree` (it is in one already), and with
 * BlaakTasks' handoff as the CLI's first prompt. Only once it has started is
 * main told, which links it to the task and sets the task In progress.
 *
 * Kept free of the terminal and the DOM, so the sequence is tested in node
 * with fakes; `actions.ts` hands it the real steps.
 */
import type { SessionOptions } from '../../../domain/launch/session-options';
import type { TaskSessionStart, TaskStartPreparation, TaskStartRequest } from '../../../domain/tasks/surface';

export interface StartTaskSessionSteps {
  prepare(request: TaskStartRequest): Promise<TaskStartPreparation>;
  /** The options a new session in this project starts with by default. */
  defaultOptions(projectPath: string): Promise<SessionOptions>;
  /** Start a Claude session in a directory, put it on screen unless `show` is false, and answer its id. */
  launch(projectPath: string, options: SessionOptions, how: { show: boolean }): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }>;
  /** The session has started: main links it to the task (in the repository's main checkout). */
  started(taskId: string, sessionId: string, projectPath: string): Promise<{ ok?: boolean; error?: string }>;
}

export interface StartTaskSessionRequest extends TaskStartRequest {
  /** Put the new session on screen. The Tasks page passes false: its row pulses instead. Default true. */
  show?: boolean;
}

/** The warning when the session started but main could not link it. */
export const NOT_LINKED = 'The session started, but could not be linked to the task.';

export async function startTaskSessionWith(
  steps: StartTaskSessionSteps, { show = true, ...request }: StartTaskSessionRequest,
): Promise<TaskSessionStart> {
  let prepared: TaskStartPreparation;
  try {
    prepared = await steps.prepare(request);
  } catch (err) {
    return { kind: 'failed', reason: (err as Error).message || 'Could not prepare the worktree' };
  }
  if (prepared.kind !== 'ready') return prepared;

  // The session is in its worktree already; `--worktree` would make another.
  const { worktree: _worktree, worktreeName: _worktreeName, ...defaults } = await steps.defaultOptions(prepared.projectPath);
  const launched = await steps.launch(prepared.worktreePath, { ...defaults, initialPrompt: prepared.prompt }, { show });
  if (!launched.ok) return { kind: 'failed', reason: launched.reason };

  const warnings = prepared.warning ? [prepared.warning] : [];
  const linked = await steps.started(request.task.id, launched.sessionId, prepared.projectPath)
    .catch((err: Error) => ({ ok: false, error: err.message }));
  if (linked?.ok === false) warnings.push(NOT_LINKED);
  return {
    kind: 'started',
    sessionId: launched.sessionId,
    projectPath: prepared.projectPath,
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  };
}
