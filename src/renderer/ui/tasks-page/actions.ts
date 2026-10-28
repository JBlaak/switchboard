/**
 * What the Tasks page does (#249): opening and closing it, following the
 * BlaakTasks switch, reading what Switchboard has linked to the tasks, the
 * row keys (S ★ D Z O Enter) and the detail's Change repo. The components
 * call these, never `window.api` or the store.
 *
 * What touches the terminal or the sidebar (starting a session, its row's
 * pulse, opening a session) comes in through `TasksPageEffects`, set once at
 * launch (`install-tasks-page`), so these are tested in node against a fake
 * `window.api` and fake effects.
 */
import { dispatch, getState } from '../../state/app-store';
import { cursorRow, tomorrow, type TaskLinks } from '../../state/tasks-slice';
import { isWorktreeProject, repositoryRoot } from '../../features/sessions/project-label';
import { resolveBlaakTasksUrl } from '../../../domain/settings/settings';
import type { Project } from '../../../domain/project/project';
import type { TaskRow } from '../../../domain/tasks/model';
import type { TaskSessionStart } from '../../../domain/tasks/surface';
import type { ExistingBranchChoice } from '../../../domain/project/branch-worktree';
import type { StartTaskSessionRequest } from '../tasks/start-task-session';

/** What the page needs from the rest of the renderer. */
export interface TasksPageEffects {
  /** Start a session on a task (`startTaskSession`). */
  startSession(request: StartTaskSessionRequest): Promise<TaskSessionStart>;
  /** The new session's sidebar row pulses once. */
  pulse(sessionId: string): void;
  /** Put a session on screen, as its sidebar row does. */
  openSession(sessionId: string): void;
  /** The projects Switchboard knows, as the sidebar has them. */
  projects(): readonly Project[];
  now(): Date;
}

const NO_EFFECTS: TasksPageEffects = {
  startSession: async () => ({ kind: 'failed', reason: 'Not ready yet' }),
  pulse: () => {},
  openSession: () => {},
  projects: () => [],
  now: () => new Date(),
};

let effects: TasksPageEffects = NO_EFFECTS;

/** Hand the page its effects: the real ones at launch, fakes in a test. */
export function setTasksPageEffects(next: TasksPageEffects): void {
  effects = next;
}

// ── The switch and the route ──

/** The stored settings, read at launch or just saved: BlaakTasks is on while a URL is set. */
export function followBlaakTasksSwitch(global: Record<string, unknown> | null | undefined): void {
  dispatch({ type: 'blaakTasksSwitched', on: resolveBlaakTasksUrl(global) !== '' });
}

/** The Tasks page takes the main area; nothing while BlaakTasks is off. */
export function openTasksPage(): void {
  if (getState().tasks.enabled) dispatch({ type: 'tasksOpened' });
}

/** Back to the session it covered, or the empty screen. */
export function closeTasksPage(): void {
  dispatch({ type: 'tasksClosed' });
}

/** ⌘T: the page, open or closed. */
export function toggleTasksPage(): void {
  if (getState().mainArea.route.kind === 'tasks') closeTasksPage();
  else openTasksPage();
}

// ── What Switchboard links to tasks ──

/** The local repositories a task can be linked to: no remote project, no worktree, each once. */
export function taskProjects(projects: readonly Project[]): string[] {
  const roots = projects
    .filter(project => !project.remote && !project.projectPath.startsWith('ssh://'))
    .map(project => repositoryRoot(project.projectPath))
    .filter(path => !isWorktreeProject(path));
  return [...new Set(roots)];
}

/**
 * Each task's repo and how many sessions worked on it, from main's links. A
 * failed read keeps what the page had.
 */
export async function loadTaskLinks(): Promise<void> {
  try {
    const roots = taskProjects(effects.projects());
    const [perProject, bySession] = await Promise.all([
      Promise.all(roots.map(async root => [root, await window.api.projectTasks(root)] as const)),
      window.api.sessionTasks(),
    ]);
    const repos: Record<string, string> = {};
    for (const [root, taskIds] of perProject) {
      for (const taskId of taskIds) repos[taskId] ??= root;
    }
    const sessions: Record<string, number> = {};
    for (const taskId of Object.values(bySession)) sessions[taskId] = (sessions[taskId] ?? 0) + 1;
    const links: TaskLinks = { repos, sessions };
    dispatch({ type: 'tasksLinksLoaded', links });
  } catch {
    // Main could not say; the rows keep what they showed.
  }
}

// ── The row keys ──

/** The task under the cursor, if the page has one. */
export function taskUnderCursor(): TaskRow | null {
  return cursorRow(getState().tasks);
}

function notice(text: string, tone: 'info' | 'error' = 'info'): void {
  dispatch({ type: 'tasksNoticed', notice: { text, tone } });
}

function why(result: { kind: string; reason?: string }): string {
  switch (result.kind) {
    case 'unreachable': return "Couldn't reach BlaakTasks";
    case 'off': return 'BlaakTasks is off';
    case 'notSetUp': return 'BlaakTasks is not set up in Claude Code';
    default: return result.reason || 'BlaakTasks did not take it';
  }
}

/** ★: starred for today, or not any more. */
export async function starTask(task: TaskRow): Promise<void> {
  const today = !task.today;
  dispatch({ type: 'tasksRowChanged', taskId: task.id, row: { ...task, today } });
  const result = await window.api.updateTask(task.id, { kind: 'star', today }).catch((err: Error) => ({ kind: 'failed' as const, reason: err.message }));
  if (result.kind === 'ok' && result.value) {
    dispatch({ type: 'tasksRowChanged', taskId: task.id, row: result.value });
  } else if (result.kind !== 'ok') {
    dispatch({ type: 'tasksRowChanged', taskId: task.id, row: task });
    notice(`Couldn't star “${task.summary ?? task.title}”: ${why(result)}`, 'error');
  }
}

/** D: done, because you pressed for it. Done that did not get through yet is sent again on the next poll. */
export async function markTaskDone(task: TaskRow): Promise<void> {
  const result = await window.api.updateTask(task.id, { kind: 'done' }).catch((err: Error) => ({ kind: 'failed' as const, reason: err.message }));
  if (result.kind === 'ok' || result.kind === 'queued') {
    dispatch({ type: 'tasksRowChanged', taskId: task.id, row: null });
    notice(result.kind === 'ok' ? `Done: “${task.summary ?? task.title}”` : `Marked done; BlaakTasks gets it on the next try`);
  } else {
    notice(`Couldn't mark it done: ${why(result)}`, 'error');
  }
}

/** Z: off the list until tomorrow. */
export async function snoozeTask(task: TaskRow): Promise<void> {
  const until = tomorrow(effects.now());
  const result = await window.api.updateTask(task.id, { kind: 'snooze', until }).catch((err: Error) => ({ kind: 'failed' as const, reason: err.message }));
  if (result.kind === 'ok') {
    dispatch({ type: 'tasksRowChanged', taskId: task.id, row: null });
    notice(`Snoozed until tomorrow: “${task.summary ?? task.title}”`);
  } else {
    notice(`Couldn't snooze it: ${why(result)}`, 'error');
  }
}

/** O: the task's page in Notion, in the browser. */
export async function openTaskInNotion(taskId: string): Promise<void> {
  const shown = getState().tasks.detail;
  let url = shown?.taskId === taskId ? shown.detail?.url ?? null : null;
  if (!url) {
    const result = await window.api.getTask(taskId).catch((err: Error) => ({ kind: 'failed' as const, reason: err.message }));
    if (result.kind !== 'ok') {
      notice(`Couldn't open it in Notion: ${why(result)}`, 'error');
      return;
    }
    url = result.value.url;
  }
  await window.api.openExternal(url);
}

/** Enter: the task's detail, with its brief, its progress and its sessions. */
export async function openTaskDetail(taskId: string): Promise<void> {
  dispatch({ type: 'tasksDetailOpened', taskId });
  const [result, sessions] = await Promise.all([
    window.api.getTask(taskId).catch((err: Error) => ({ kind: 'failed' as const, reason: err.message })),
    window.api.taskSessions(taskId).catch(() => null),
  ]);
  dispatch({
    type: 'tasksDetailLoaded',
    taskId,
    detail: result.kind === 'ok' ? result.value : null,
    error: result.kind === 'ok' ? null : why(result),
    sessions,
  });
}

export function closeTaskDetail(): void {
  dispatch({ type: 'tasksDetailClosed' });
}

/** One of the task's pull requests, in the browser. */
export function openTaskPullRequest(url: string): void {
  void window.api.openExternal(url);
}

/** One of the task's sessions, on screen; the page gives way to it. */
export function openTaskSession(sessionId: string): void {
  effects.openSession(sessionId);
}

// ── Starting ──

/** How S starts: in a project picked from the list, or again on its existing branch. */
export interface StartChoice {
  projectPath?: string;
  existing?: ExistingBranchChoice;
}

/**
 * S: a session on the task, without leaving the page. With a linked repo (or
 * a project picked) it starts there; otherwise Ask Patch routes it, from the
 * title and the brief. The new sidebar row pulses; anything that stopped it
 * (Patch unsure, no match, an existing branch, a failure) stays under the row
 * for the next choice.
 */
export async function startFromTask(task: TaskRow, choice: StartChoice = {}): Promise<void> {
  const tasks = getState().tasks;
  if (tasks.start?.phase === 'starting') return;
  dispatch({ type: 'tasksStartAsked', taskId: task.id });

  // Whether Ask Patch picks the repo: none asked for, and none linked, as main has it now.
  if (!choice.projectPath && !tasks.links.repos[task.id]) await loadTaskLinks();
  const routed = !choice.projectPath && !getState().tasks.links.repos[task.id];
  const brief = routed ? await briefOf(task.id) : undefined;
  let outcome: TaskSessionStart;
  try {
    outcome = await effects.startSession({
      task: { id: task.id, title: task.title, ...(brief ? { brief } : {}) },
      ...(choice.projectPath ? { projectPath: choice.projectPath } : {}),
      ...(choice.existing ? { existing: choice.existing } : {}),
      show: false,
    });
  } catch (err) {
    outcome = { kind: 'failed', reason: (err as Error).message || 'Could not start the session' };
  }
  if (outcome.kind === 'started') effects.pulse(outcome.sessionId);
  dispatch({ type: 'tasksStartAnswered', taskId: task.id, outcome, routed });
  if (outcome.kind === 'started') void loadTaskLinks();
}

/** The task's brief, for routing: the detail's when it is open, else asked; nothing when it can't be had. */
async function briefOf(taskId: string): Promise<string | undefined> {
  const shown = getState().tasks.detail;
  if (shown?.taskId === taskId && shown.detail) return shown.detail.brief || undefined;
  const result = await window.api.getTask(taskId).catch(() => null);
  return result?.kind === 'ok' ? result.value.brief || undefined : undefined;
}

/** Put the start's answer away. */
export function dismissStart(): void {
  dispatch({ type: 'tasksStartDismissed' });
}

/** The project list: "Other project…" for a start, or Change repo in the detail. */
export function openProjectList(taskId: string, purpose: 'start' | 'repo'): void {
  dispatch({ type: 'tasksPickerOpened', taskId, purpose });
}

export function closeProjectList(): void {
  dispatch({ type: 'tasksPickerClosed' });
}

/** A project picked from the list: start there, or (Change repo) link the task to it. */
export async function pickProject(task: TaskRow, projectPath: string): Promise<void> {
  const picker = getState().tasks.picker;
  dispatch({ type: 'tasksPickerClosed' });
  if (picker?.purpose === 'repo') {
    await changeTaskRepo(task.id, projectPath);
    return;
  }
  await startFromTask(task, { projectPath });
}

/** Change repo: the task's next start goes to this project. */
export async function changeTaskRepo(taskId: string, projectPath: string): Promise<void> {
  const result = await window.api.setTaskRepo(taskId, projectPath).catch((err: Error) => ({ ok: false, error: err.message }));
  if (result.ok === false || result.error) {
    notice(`Couldn't change its repo: ${String(result.error ?? 'main did not take it')}`, 'error');
    return;
  }
  await loadTaskLinks();
}

/** The local projects the list offers, as the sidebar has them. */
export function pickableProjects(): string[] {
  return taskProjects(effects.projects());
}
