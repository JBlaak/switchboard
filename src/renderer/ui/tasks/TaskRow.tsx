/**
 * A task as a row (#249), and its status pill: the Tasks page lists these,
 * and the project page's Tasks section (#251) reuses them.
 *
 * The row draws only: ★ when starred for today, the title, the meta line
 * (`taskMeta`) and the status pill, lit when it is under the keyboard cursor.
 * Its keys and clicks are the list's, which passes what to do in.
 */
import type { JSX, ReactNode } from 'react';
import { projectLabel } from '../../features/sessions/project-label';
import type { TaskRow as Task, TaskStatus } from '../../../domain/tasks/model';
import { statusTone, taskMeta, taskTitle } from './task-row';

export function TaskStatusPill({ status }: { status: TaskStatus }): JSX.Element {
  return <span className={'tk-pill is-' + statusTone(status)}>{status}</span>;
}

export interface TaskRowProps {
  task: Task;
  /** The project path the task is linked to in Switchboard; null when it has none yet. */
  repo: string | null;
  /** How many sessions worked on the task. */
  sessions: number;
  /** Under the keyboard cursor. */
  cursor?: boolean;
  /** Leave the repo out of the meta line: the list is one repo's already. */
  showRepo?: boolean;
  /** A session is being started on it. */
  starting?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Drawn under the row, inside it: a start's answer, say. */
  children?: ReactNode;
}

export function TaskRow({
  task, repo, sessions, cursor = false, showRepo = true, starting = false, onClick, onDoubleClick, children,
}: TaskRowProps): JSX.Element {
  return (
    <div
      className={'tk-row' + (cursor ? ' is-cursor' : '')}
      role="option"
      aria-selected={cursor}
      data-task-id={task.id}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="tk-row-line">
        <span className={'tk-star' + (task.today ? ' is-on' : '')} aria-label={task.today ? 'Starred for today' : undefined}>
          {task.today ? '★' : ''}
        </span>
        <span className="tk-row-text">
          <span className="tk-row-title" title={task.title}>{taskTitle(task)}</span>
          <span className="tk-row-meta">{taskMeta(task, repo ? projectLabel(repo) : null, sessions, { showRepo })}</span>
        </span>
        {starting && <span className="tk-starting">Starting…</span>}
        <TaskStatusPill status={task.status} />
      </div>
      {children}
    </div>
  );
}
