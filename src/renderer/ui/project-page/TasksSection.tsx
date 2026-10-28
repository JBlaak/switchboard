/**
 * The project page's Tasks section (#251), under Pull requests: the
 * BlaakTasks tasks linked to this repo that aren't Done or Dropped, newest
 * link first, one Tasks page row each (#249) without the repo in its meta
 * line. The page's cursor walks them, with the Tasks page's keys on the row
 * under it (`page-keys`): S starts a session in this repo, with no routing,
 * and its sidebar row pulses; ↵ shows its detail under the row.
 *
 * Left out while BlaakTasks is off, before the first answer, and when no open
 * task is linked to the repo. A start's answer, the detail and a key's notice
 * are the Tasks page's (`tasks` slice), drawn here under the row.
 */
import type { JSX } from 'react';
import { dispatch } from '../../state/app-store';
import { useStore } from '../use-store';
import { TaskRow } from '../tasks/TaskRow';
import { StartPanel } from '../tasks-page/StartPanel';
import { TaskDetailPane } from '../tasks-page/TaskDetailPane';
import { cursorId, tasksViewOf } from './page-rows';
import { openProjectTaskDetail } from './project-tasks';

export function TasksSection({ projectPath }: { projectPath: string }): JSX.Element | null {
  const enabled = useStore(state => state.tasks.enabled);
  const page = useStore(state => state.projectPage);
  const start = useStore(state => state.tasks.start);
  const detail = useStore(state => state.tasks.detail);
  const notice = useStore(state => state.tasks.notice);
  const rows = enabled ? tasksViewOf(page, projectPath) : null;
  if (!rows || !page.tasks) return null;
  const { sessions } = page.tasks;

  return (
    <section className="pp-section pp-tasks" aria-labelledby="pp-tasks-heading">
      <div className="pp-section-head">
        <h2 id="pp-tasks-heading">Tasks</h2>
        <span className="pp-count">{page.tasks.rows.length} open</span>
      </div>
      <div className="pp-card" role="listbox" aria-label="Tasks">
        {rows.length === 0 && <div className="pp-quiet">No task here matches.</div>}
        {rows.map(task => {
          const id = cursorId.task(task.id);
          return (
            <div key={task.id} data-cursor-id={id}>
              <TaskRow
                task={task}
                repo={projectPath}
                sessions={sessions[task.id] ?? 0}
                cursor={page.cursor === id}
                showRepo={false}
                starting={start?.taskId === task.id && start.phase === 'starting'}
                onClick={() => dispatch({ type: 'projectCursorMoved', target: id })}
                onDoubleClick={() => openProjectTaskDetail(task.id)}
              >
                {start?.taskId === task.id && <StartPanel task={task} start={start} />}
              </TaskRow>
              {detail?.taskId === task.id && <TaskDetailPane task={task} />}
            </div>
          );
        })}
      </div>
      {notice && <div className={'pp-tasks-notice' + (notice.tone === 'error' ? ' is-error' : '')} role="status">{notice.text}</div>}
    </section>
  );
}
