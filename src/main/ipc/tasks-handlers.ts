/**
 * BlaakTasks in Switchboard (#248): the task lists, a task, its changes and
 * repo, starting a session from it, the links between tasks and sessions, and
 * the watches that keep the poll running.
 *
 * Everything goes through `TasksService`, which answers `off` (or nothing)
 * while no BlaakTasks URL is set, so no call here reaches BlaakTasks then.
 * What the renderer sends is checked before it gets that far.
 */
import { INVOKE } from '../../ipc/channels';
import type { ExistingBranchChoice } from '../../domain/project/branch-worktree';
import type { TaskListOptions, TaskView } from '../../domain/tasks/model';
import type { TaskChange, TaskQuery, TaskStartRequest } from '../../domain/tasks/surface';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

const VIEWS: readonly TaskView[] = ['quick', 'due', 'today', 'pitch', 'waiting', 'snoozed', 'bucket', 'client', 'topic'];

export function registerTasksHandlers(ipc: IpcRegistrar, app: Pick<Container, 'tasks'>): void {
  const { tasks } = app;

  ipc.handle(INVOKE.tasksList, (query: unknown) => tasks.list(taskQuery(query)));
  ipc.handle(INVOKE.tasksGet, (taskId: unknown) => tasks.get(text(taskId, 'task id')));
  ipc.handle(INVOKE.tasksUpdate, (taskId: unknown, change: unknown) =>
    tasks.update(text(taskId, 'task id'), taskChange(change)));
  ipc.handle(INVOKE.tasksSetRepo, (taskId: unknown, projectPath: unknown) => {
    tasks.setRepo(text(taskId, 'task id'), text(projectPath, 'project path'));
    return { ok: true };
  });

  ipc.handle(INVOKE.tasksPrepareStart, (request: unknown) => tasks.prepareStart(startRequest(request)));
  ipc.handle(INVOKE.tasksSessionStarted, (taskId: unknown, sessionId: unknown, projectPath: unknown) => {
    tasks.sessionStarted(text(taskId, 'task id'), text(sessionId, 'session id'), text(projectPath, 'project path'));
    return { ok: true };
  });
  ipc.handle(INVOKE.tasksLinkSession, async (sessionId: unknown, taskId: unknown) => {
    await tasks.link(text(sessionId, 'session id'), text(taskId, 'task id'));
    return { ok: true };
  });
  ipc.handle(INVOKE.tasksUnlinkSession, (sessionId: unknown) => {
    tasks.unlink(text(sessionId, 'session id'));
    return { ok: true };
  });

  ipc.handle(INVOKE.tasksSessionTask, (sessionId: unknown) => tasks.sessionTask(text(sessionId, 'session id')));
  ipc.handle(INVOKE.tasksSessionTasks, () => tasks.sessionTasks());
  ipc.handle(INVOKE.tasksTaskSessions, (taskId: unknown) => tasks.taskSessions(text(taskId, 'task id')));
  ipc.handle(INVOKE.tasksProjectTasks, (projectPath: unknown) => tasks.projectTasks(text(projectPath, 'project path')));

  ipc.handle(INVOKE.tasksWatch, (watchId: unknown, query: unknown) => {
    tasks.watch(text(watchId, 'watch id'), query === null || query === undefined ? null : taskQuery(query));
  });
  ipc.handle(INVOKE.tasksUnwatch, (watchId: unknown) => {
    tasks.unwatch(text(watchId, 'watch id'));
  });
}

/** A non-empty string, or the error the registrar turns into `{ ok: false, error }`. */
function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Not a ${what}: ${String(value)}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function taskQuery(value: unknown): TaskQuery {
  if (!isRecord(value) || !VIEWS.includes(value.view as TaskView)) throw new Error('Not a task list: ' + JSON.stringify(value));
  const options = isRecord(value.options) ? listOptions(value.options) : undefined;
  return { view: value.view as TaskView, ...(options ? { options } : {}) };
}

function listOptions(value: Record<string, unknown>): TaskListOptions {
  const options: TaskListOptions = {};
  if (typeof value.name === 'string') options.name = value.name;
  if (typeof value.query === 'string') options.query = value.query;
  if (value.context === 'work' || value.context === 'private') options.context = value.context;
  if (typeof value.limit === 'number' && Number.isFinite(value.limit)) options.limit = value.limit;
  return options;
}

function taskChange(value: unknown): TaskChange {
  if (isRecord(value)) {
    if (value.kind === 'star' && typeof value.today === 'boolean') return { kind: 'star', today: value.today };
    if (value.kind === 'snooze' && (value.until === null || typeof value.until === 'string')) return { kind: 'snooze', until: value.until };
    if (value.kind === 'done') return { kind: 'done' };
  }
  throw new Error('Not a change to a task: ' + JSON.stringify(value));
}

function startRequest(value: unknown): TaskStartRequest {
  if (!isRecord(value) || !isRecord(value.task)) throw new Error('Not a request to start a session on a task');
  const { task, projectPath, existing } = value;
  if (existing !== undefined && existing !== 'replace' && existing !== 'reuse') {
    throw new Error('Not a way to handle an existing branch: ' + String(existing));
  }
  if (projectPath !== undefined && typeof projectPath !== 'string') throw new Error('Not a project path: ' + String(projectPath));
  return {
    task: {
      id: text(task.id, 'task id'),
      title: text(task.title, 'task title'),
      ...(typeof task.brief === 'string' ? { brief: task.brief } : {}),
      ...(typeof task.instructions === 'string' ? { instructions: task.instructions } : {}),
    },
    ...(projectPath ? { projectPath } : {}),
    ...(existing ? { existing: existing as ExistingBranchChoice } : {}),
  };
}
