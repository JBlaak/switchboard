/**
 * What the project page's Tasks section does (#251): reading the repo's open
 * tasks, and the section's own takes on the Tasks page's actions (S starts in
 * this repo, ↵ shows the detail). The row keys ★, D, Z and O are the Tasks
 * page's actions as they are; the slice follows their `tasksRowChanged`.
 *
 * Free of the terminal and the DOM (a start goes through the Tasks page's
 * effects), so it is tested in node against a fake `window.api`.
 */
import { dispatch, getState } from '../../state/app-store';
import { overviewRequest } from '../../state/project-page-slice';
import type { RendererState } from '../../state/root';
import { loadTaskLinks, openTaskDetail, startFromTask } from '../tasks-page/actions';
import { PROJECT_TASKS_ASKED, localDay, projectTaskRows } from './page-rows';
import type { BlaakTasksResult, TaskDetail, TaskRow } from '../../../domain/tasks/model';

/** The project whose open tasks are read now: its overview on screen, and BlaakTasks on. */
export function tasksRequest(state: RendererState): string | null {
  return state.tasks.enabled ? overviewRequest(state)?.projectPath ?? null : null;
}

/**
 * Read the project's open tasks: the ones Switchboard linked to it, newest
 * link first (the newest `PROJECT_TASKS_ASKED`), each asked of BlaakTasks,
 * those Done, Dropped or snoozed past today left out; and how many sessions
 * worked on each. Nothing is asked while BlaakTasks is off. A task BlaakTasks
 * did not answer for keeps its row; a failed read keeps what the page had.
 */
export async function loadProjectTasks(projectPath: string, now: Date = new Date()): Promise<void> {
  if (!getState().tasks.enabled) return;
  try {
    const [linked, bySession] = await Promise.all([window.api.projectTasks(projectPath), window.api.sessionTasks()]);
    const ids = linked.slice(0, PROJECT_TASKS_ASKED);
    const answers = await Promise.all(ids.map(id => window.api.getTask(id).catch(
      (err: Error): BlaakTasksResult<TaskDetail> => ({ kind: 'unreachable', reason: err.message }),
    )));
    // Switched off, or another project's page, while it was asked.
    const state = getState();
    if (!state.tasks.enabled || state.projectPage.projectPath !== projectPath) return;
    const had = state.projectPage.tasks?.projectPath === projectPath ? state.projectPage.tasks.rows : [];
    const rows = projectTaskRows(ids, answers, had, localDay(now));
    const sessions: Record<string, number> = {};
    for (const taskId of Object.values(bySession)) {
      if (rows.some(row => row.id === taskId)) sessions[taskId] = (sessions[taskId] ?? 0) + 1;
    }
    dispatch({ type: 'projectTasksAnswered', projectPath, rows, sessions });
  } catch {
    // Main could not say; the section stays as it was.
  }
}

/**
 * S on a task in the section: a session on it in this project, with no Ask
 * Patch routing, without leaving the page. Its new sidebar row pulses, and
 * (`install-project-page`) the overview and the section are read again;
 * anything that stopped it (its branch exists, a failure) stays under the
 * row, as on the Tasks page.
 */
export function startProjectTask(projectPath: string, task: TaskRow): Promise<void> {
  return startFromTask(task, { projectPath });
}

/** ↵ on a task in the section: its detail, under its row. The repo it shows comes from the links. */
export function openProjectTaskDetail(taskId: string): void {
  void openTaskDetail(taskId);
  void loadTaskLinks();
}
