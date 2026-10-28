/**
 * What a task row says (#249), apart from drawing it: its meta line and its
 * status pill's tone. Shared by every surface that lists tasks (the Tasks
 * page, the project page's Tasks section, #251). Pure, so it is tested in node.
 */
import type { TaskRow, TaskStatus } from '../../../domain/tasks/model';

/** The status pill's tone: a class on `.tk-pill`. */
export function statusTone(status: TaskStatus): 'not-started' | 'in-progress' | 'waiting' | 'done' | 'dropped' {
  switch (status) {
    case 'Not started': return 'not-started';
    case 'In progress': return 'in-progress';
    case 'Waiting': return 'waiting';
    case 'Done': return 'done';
    case 'Dropped': return 'dropped';
  }
}

/** The text a row leads with: BlaakTasks' shorter line when it has one. */
export function taskTitle(task: TaskRow): string {
  return task.summary?.trim() || task.title;
}

/**
 * The line under a task's title: its context (bucket, client), the repo it is
 * linked to in Switchboard ("no project yet" without one) and how many
 * sessions worked on it, then when it is due and who it waits on.
 *
 * `repo` is the repo's label, already shortened; null when it has none.
 * `showRepo` false leaves the repo out, for a list that is one repo's already.
 */
export function taskMeta(task: TaskRow, repo: string | null, sessions: number, { showRepo = true } = {}): string {
  const parts: string[] = [];
  for (const part of [task.bucket, task.client]) {
    const text = part?.trim();
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (showRepo) parts.push(repo ?? 'no project yet');
  if (sessions > 0) parts.push(sessions === 1 ? '1 session' : `${sessions} sessions`);
  if (task.dueLabel) parts.push('due ' + task.dueLabel);
  if (task.waitingOn) parts.push('waiting on ' + task.waitingOn);
  return parts.join(' · ');
}
