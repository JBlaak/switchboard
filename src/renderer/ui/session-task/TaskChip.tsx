/**
 * The task chip in the session header (#250): the task the session on screen
 * works on, and its status. A click opens the Session work page on its Task
 * tab. Nothing shows for a session without a task, or while BlaakTasks is off.
 */
import type { JSX } from 'react';
import { shallowEqual } from '../../state/store';
import { sessionTaskOf, taskName } from '../../state/session-task-slice';
import { useStore } from '../use-store';
import { openTaskTab } from './actions';
import { TaskIcon } from './TaskStatusPill';

export function TaskChip({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const task = useStore(state => {
    const linked = sessionTaskOf(state.sessionTask, sessionId);
    if (!linked) return null;
    return { title: linked.detail?.title ?? null, name: linked.detail ? taskName(linked.detail) : null, status: linked.detail?.status ?? null };
  }, shallowEqual);
  if (!task || !sessionId) return null;

  const label = task.name ?? 'Task';
  return (
    <button
      type="button"
      id="terminal-header-task"
      className={'st-chip' + (task.status ? ' is-' + task.status.toLowerCase().replace(' ', '-') : '')}
      title={(task.title ?? 'This session’s task') + ' · Open the Task tab'}
      aria-label={'Task: ' + (task.title ?? 'loading') + (task.status ? ', ' + task.status : '')}
      onClick={() => void openTaskTab(sessionId)}
    >
      <TaskIcon size={11} />
      <span className="st-chip-title">{label}</span>
      {task.status && <span className="st-chip-status">{task.status}</span>}
    </button>
  );
}
