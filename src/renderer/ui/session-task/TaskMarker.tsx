/**
 * The sidebar row's task marker (#250): a small mark on a row whose session
 * works on a BlaakTasks task, naming the task on hover. Nothing for a row
 * without one, or while BlaakTasks is off.
 */
import type { JSX } from 'react';
import { sessionTaskOf } from '../../state/session-task-slice';
import { useStore } from '../use-store';
import { TaskIcon } from './TaskStatusPill';

export function TaskMarker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const title = useStore(state => {
    const linked = sessionTaskOf(state.sessionTask, sessionId);
    return linked ? linked.detail?.title ?? '' : null;
  });
  if (title === null) return null;
  const label = title ? 'Task: ' + title : 'Linked to a task';
  return (
    <span className="session-task-marker" data-testid="session-task-marker" title={label} aria-label={label} role="img">
      <TaskIcon size={11} />
    </span>
  );
}
