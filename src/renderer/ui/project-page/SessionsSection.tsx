/**
 * The project page's Sessions section (#173): the project's five most recent
 * sessions, running ones first, each with its worktree's branch and its age.
 * A click opens one, and the page gives way to it; Show all filters the
 * sidebar to the project instead of growing a second list here.
 *
 * Read from the cached projects, which live outside the store (see
 * `session-store`); the section follows the session list's redraws, which is
 * when the cache has changed, and the running set. The page's filter (/)
 * narrows it by name, and its rows are cursor rows (#174).
 */
import type { JSX } from 'react';
import { useStore } from '../use-store';
import { view } from '../../state/session-store';
import { sessionDisplayName } from '../../state/session-list-layout';
import { formatDate } from '../../lib/format';
import { projectSessions, type ProjectSessions } from './project-sessions';
import { openProjectSession, showProjectInSidebar } from './actions';
import { cursorId, matchesFilter } from './page-rows';

/** The sessions the section lists, as the cache has them now, narrowed by the page's filter. */
export function sessionsShown(projectPath: string, running: ReadonlySet<string>, filter: string): ProjectSessions {
  const { lines, total } = projectSessions(view.cachedProjects, projectPath, running);
  return { lines: lines.filter(line => matchesFilter(sessionDisplayName(line.session) + ' ' + (line.worktree ?? ''), filter)), total };
}

export function SessionsSection({ projectPath }: { projectPath: string }): JSX.Element {
  useStore(state => state.sessionList.revision);
  const running = useStore(state => state.view.activePtyIds);
  const now = useStore(state => state.sessionList.now) || Date.now();
  const filter = useStore(state => state.projectPage.filter);
  const cursor = useStore(state => state.projectPage.cursor);
  const { lines, total } = sessionsShown(projectPath, running, filter);

  return (
    <section className="pp-section" aria-labelledby="pp-sessions-heading">
      <div className="pp-section-head">
        <h2 id="pp-sessions-heading">Sessions</h2>
        <span className="pp-count">{total}</span>
        {total > 0 && (
          <button type="button" className="pp-link" onClick={() => showProjectInSidebar(projectPath)}>Show all</button>
        )}
      </div>
      <div className="pp-card">
        {lines.length === 0 && <div className="pp-quiet">{total > 0 ? 'No session here matches.' : 'No sessions in this project yet.'}</div>}
        {lines.map(({ session, running: live, worktree }) => (
          <button
            type="button"
            key={session.sessionId}
            className={'pp-row pp-session' + (cursor === cursorId.session(session.sessionId) ? ' is-cursor' : '')}
            data-project-session={session.sessionId}
            data-cursor-id={cursorId.session(session.sessionId)}
            onClick={() => openProjectSession(session.sessionId)}
          >
            <span className={'pp-dot' + (live ? ' is-running' : '')} aria-label={live ? 'Running' : undefined} />
            <span className="pp-row-text">
              <span className="pp-row-title">{sessionDisplayName(session) || 'Untitled session'}</span>
              {worktree && <span className="pp-row-meta pp-mono">{worktree}</span>}
            </span>
            <span className="pp-age">{formatDate(new Date(session.modified), now)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
