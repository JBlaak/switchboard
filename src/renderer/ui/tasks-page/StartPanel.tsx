/**
 * How a start from the Tasks page went (#249), under the task's row:
 *
 * - asked: any extra instructions first (`StartInstructions`), unless the
 *   task's detail is open, which asks instead;
 * - started, after Ask Patch picked the repo: Patch's line, "Starting in …";
 * - Patch unsure: up to three projects to start in, and "Other project…";
 * - no match: Patch's reason, and the project list;
 * - the task's branch exists: Continue, Open its session, or Delete and
 *   start again (asked once more), as an issue start offers (`IssueDetail`);
 * - failed: why.
 */
import { useState, type JSX, type ReactNode } from 'react';
import { projectLabel } from '../../features/sessions/project-label';
import { deleteLine, existingLine } from '../session-work/plan/IssueDetail';
import type { TaskRow } from '../../../domain/tasks/model';
import type { TasksStart } from '../../state/tasks-slice';
import { useStore } from '../use-store';
import { openProjectList, openTaskSession, startFromTask } from './actions';
import { ProjectList } from './ProjectList';
import { StartInstructions } from './StartInstructions';

export function StartPanel({ task, start }: { task: TaskRow; start: TasksStart }): JSX.Element | null {
  const picking = useStore(state => state.tasks.picker?.taskId === task.id && state.tasks.picker.purpose === 'start');
  const inDetail = useStore(state => state.tasks.detail?.taskId === task.id);
  if (start.phase === 'instructing') return inDetail ? null : <StartInstructions task={task} />;
  if (start.phase !== 'answered') return null;
  const { outcome } = start;
  switch (outcome.kind) {
    case 'started':
      return (
        <div className="tk-start" role="status">
          {start.routed
            ? <PatchLine>Starting in <b>{projectLabel(outcome.projectPath)}</b>.</PatchLine>
            : <span className="tk-start-text">Started in <b>{projectLabel(outcome.projectPath)}</b>.</span>}
          {outcome.warning && <span className="tk-start-text is-warning">{outcome.warning}</span>}
        </div>
      );
    case 'unsure':
      return (
        <div className="tk-start" role="group" aria-label="Pick a project">
          <PatchLine>Could be a few places.</PatchLine>
          <div className="tk-choices">
            {outcome.candidates.slice(0, 3).map((projectPath, i) => (
              <button
                type="button"
                key={projectPath}
                className={'sw-btn' + (i === 0 ? ' is-primary' : '')}
                onClick={() => void startFromTask(task, { projectPath })}
              >
                {projectLabel(projectPath)}
              </button>
            ))}
            <button type="button" className="sw-btn" onClick={() => openProjectList(task.id, 'start')}>Other project…</button>
          </div>
          {picking && <ProjectList task={task} />}
        </div>
      );
    case 'noMatch':
      return (
        <div className="tk-start" role="group" aria-label="Pick a project">
          <PatchLine>{outcome.reason || 'No project fits this one. Pick where it goes.'}</PatchLine>
          {picking ? <ProjectList task={task} /> : (
            <div className="tk-choices">
              <button type="button" className="sw-btn" onClick={() => openProjectList(task.id, 'start')}>Pick a project…</button>
            </div>
          )}
        </div>
      );
    case 'existing':
      return <ExistingBranch task={task} outcome={outcome} />;
    case 'failed':
      return <div className="tk-start is-error" role="alert">{outcome.reason}</div>;
    default:
      return null;
  }
}

function PatchLine({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="tk-patch">
      <span className="tk-patch-who">Patch</span>
      <span className="tk-start-text">{children}</span>
    </span>
  );
}

type Existing = Extract<Extract<TasksStart, { phase: 'answered' }>['outcome'], { kind: 'existing' }>;

/** The task's branch exists already: what is on it, and what to do. Deleting asks once more. */
function ExistingBranch({ task, outcome }: { task: TaskRow; outcome: Existing }): JSX.Element {
  const [deleting, setDeleting] = useState(false);
  const { existing, projectPath } = outcome;

  if (deleting) {
    return (
      <div className="tk-start is-error" role="alertdialog" aria-label="Delete worktree and branch">
        <span className="tk-start-text">{deleteLine(existing)}</span>
        <div className="tk-choices">
          <button type="button" className="sw-btn is-warn" onClick={() => void startFromTask(task, { projectPath, existing: 'replace' })}>
            Delete and start again
          </button>
          <button type="button" className="sw-btn" onClick={() => setDeleting(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="tk-start" role="alert" aria-label="Branch exists">
      <span className="tk-start-text">{existingLine(existing)}</span>
      <div className="tk-choices">
        <button type="button" className="sw-btn is-primary" onClick={() => void startFromTask(task, { projectPath, existing: 'reuse' })}>
          Continue
        </button>
        {existing.sessionId && (
          <button type="button" className="sw-btn" onClick={() => openTaskSession(existing.sessionId!)}>Open its session</button>
        )}
        {!existing.main && (
          <button type="button" className="sw-btn is-warn" onClick={() => setDeleting(true)}>Delete and start again…</button>
        )}
      </div>
      <span className="tk-start-note">{'Branch ' + existing.branch + ' · ' + projectLabel(projectPath)}</span>
    </div>
  );
}
