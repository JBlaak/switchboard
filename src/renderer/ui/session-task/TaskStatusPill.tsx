/** A task's status as a pastel pill: In progress blue, Waiting sun, Done mint, the rest grey. */
import type { JSX } from 'react';
import { statusTone } from '../../state/session-task-slice';
import type { TaskStatus } from '../../../domain/tasks/model';

export function TaskStatusPill({ status }: { status: TaskStatus }): JSX.Element {
  return <span className={'st-status is-' + statusTone(status)}>{status}</span>;
}

/** The task mark the chip and the sidebar marker share: a ticked square. */
export function TaskIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  );
}
