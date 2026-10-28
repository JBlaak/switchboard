/**
 * A task's detail on the Tasks page (#249), beside the list while it is open
 * (Enter): its brief, its progress log, its pull requests, the sessions that
 * worked on it, and its repo, with Change repo for a wrong pick.
 */
import type { JSX } from 'react';
import { useStore } from '../use-store';
import { sessionMap } from '../../state/session-store';
import { headerNameFor } from '../../features/sessions/terminal-header';
import { projectLabel } from '../../features/sessions/project-label';
import type { TaskRow } from '../../../domain/tasks/model';
import { TaskStatusPill } from '../tasks/TaskRow';
import { taskTitle } from '../tasks/task-row';
import {
  closeTaskDetail, openProjectList, openTaskInNotion, openTaskPullRequest, openTaskSession, startFromTask,
} from './actions';

/** `#412` for a GitHub PR's URL; the URL itself for anything else. */
function pullRequestLabel(url: string): string {
  const number = url.match(/\/pull\/(\d+)/)?.[1];
  return number ? '#' + number : url;
}
import { ProjectList } from './ProjectList';

function sessionName(sessionId: string): string {
  const session = sessionMap.get(sessionId);
  return (session && headerNameFor(session)) || 'Untitled session';
}

export function TaskDetailPane({ task }: { task: TaskRow }): JSX.Element {
  const view = useStore(state => state.tasks.detail);
  const repo = useStore(state => state.tasks.links.repos[task.id] ?? null);
  const changing = useStore(state => state.tasks.picker?.taskId === task.id && state.tasks.picker.purpose === 'repo');
  const detail = view?.taskId === task.id ? view.detail : null;
  const sessions = view?.taskId === task.id ? view.sessions : null;
  const error = view?.taskId === task.id ? view.error : null;

  return (
    <aside className="tk-detail" aria-label="Task detail">
      <div className="tk-detail-head">
        <TaskStatusPill status={task.status} />
        {task.today && <span className="tk-star is-on" aria-label="Starred for today">★</span>}
        <button type="button" className="sw-btn tk-detail-close" onClick={closeTaskDetail} aria-label="Close detail (Esc)">
          Close <kbd className="sw-kbd">esc</kbd>
        </button>
      </div>
      <h2 className="tk-detail-title">{taskTitle(task)}</h2>
      {task.summary && task.summary !== task.title && <p className="tk-detail-full">{task.title}</p>}

      {error && <div className="tk-start is-error" role="alert">{error}</div>}
      {!detail && !error && <div className="tk-quiet">Loading…</div>}

      {detail && (
        <section className="tk-detail-section">
          <h3>Brief</h3>
          {detail.brief.trim() ? <p className="tk-brief">{detail.brief}</p> : <div className="tk-quiet">No brief.</div>}
        </section>
      )}

      {detail && detail.progress.length > 0 && (
        <section className="tk-detail-section">
          <h3>Progress</h3>
          <ol className="tk-log">
            {detail.progress.map((entry, i) => (
              <li key={i}><span className="tk-log-day">{entry.day}</span><span>{entry.text}</span></li>
            ))}
          </ol>
        </section>
      )}

      {task.pullRequests.length > 0 && (
        <section className="tk-detail-section">
          <h3>Pull requests</h3>
          <div className="tk-choices">
            {task.pullRequests.map(url => (
              <button type="button" key={url} className="sw-btn" onClick={() => openTaskPullRequest(url)}>
                {pullRequestLabel(url)}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="tk-detail-section">
        <h3>Sessions</h3>
        {sessions && sessions.sessions.length > 0 ? (
          <div className="tk-sessions">
            {sessions.sessions.map(sessionId => (
              <button type="button" key={sessionId} className="tk-session" onClick={() => openTaskSession(sessionId)}>
                <span className="tk-session-name">{sessionName(sessionId)}</span>
                {sessions.owner === sessionId && <span className="tk-owner">owner</span>}
              </button>
            ))}
          </div>
        ) : <div className="tk-quiet">{sessions ? 'No session has worked on it yet.' : '…'}</div>}
      </section>

      <section className="tk-detail-section">
        <h3>Repo</h3>
        <div className="tk-repo">
          <span className={repo ? 'tk-repo-name' : 'tk-quiet'}>{repo ? projectLabel(repo) : 'No project yet: Ask Patch picks one on start'}</span>
          {!changing && (
            <button type="button" className="pp-link" onClick={() => openProjectList(task.id, 'repo')}>
              {repo ? 'Change repo…' : 'Pick a repo…'}
            </button>
          )}
        </div>
        {changing && <ProjectList task={task} />}
      </section>

      <div className="tk-choices tk-detail-actions">
        <button type="button" className="sw-btn is-primary" onClick={() => void startFromTask(task)}>
          Start session <kbd className="sw-kbd">S</kbd>
        </button>
        <button type="button" className="sw-btn" onClick={() => void openTaskInNotion(task.id)}>
          Open in Notion <kbd className="sw-kbd">O</kbd>
        </button>
      </div>
    </aside>
  );
}
