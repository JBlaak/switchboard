/**
 * A group of sessions sharing a slug.
 *
 * Sessions started from one accepted plan share its slug, and showing them as
 * one collapsible row is what stops a single long-running task from filling
 * the sidebar. A group with something running promotes those to the top and
 * hides the rest behind a "more" toggle, so the live one is always in reach.
 *
 * Which sessions are running is read live, like a row's classes; the group's
 * place, name and members come from the layout.
 */
import { useRef } from 'react';
import { projectLabel } from '../../features/sessions/project-label';
import { formatDate } from '../../lib/format';
import { groupDisplayName } from '../../state/session-list-layout';
import { useStore } from '../use-store';
import { archiveGroup, expandSlugGroup, toggleSlugGroup } from './actions';
import { headerTarget } from './cursor';
import { HTML } from './markup';
import { RepoLink } from './RowMeta';
import { SessionItem } from './SessionItem';
import type { JSX } from 'react';
import type { SessionListGroup } from '../../state/session-list-layout';

export function SlugGroup({ group }: { group: SessionListGroup }): JSX.Element {
  const el = useRef<HTMLDivElement>(null);
  const { id, sessions, projectPath } = group;
  const expanded = useStore(s => !!s.sessionList.expandedSlugs[id]);
  const leaving = useStore(s => !!s.sessionList.leaving[id]);
  const headerCursor = useStore(s => s.sessionList.cursor === headerTarget(id));
  const moreCursor = useStore(s => s.sessionList.cursor === 'sgm-' + id);
  const now = useStore(s => s.sessionList.now);
  // The running ones, as a string so an unrelated poll does not re-render the group.
  const runningIds = useStore(s => sessions.filter(r => s.view.activePtyIds.has(r.session.sessionId))
    .map(r => r.session.sessionId).join(' '));
  const running = new Set(runningIds ? runningIds.split(' ') : []);

  const promoted = sessions.filter(r => running.has(r.session.sessionId));
  const rest = sessions.filter(r => !running.has(r.session.sessionId));
  const newest = sessions[0].session;

  const className = 'slug-group' + (expanded ? '' : ' collapsed') + (promoted.length ? ' has-promoted' : '');

  return (
    <div ref={el} id={id} className={className} data-leaving={leaving ? '' : undefined}>
      <div
        className={'slug-group-header' + (headerCursor ? ' kbd-cursor' : '')}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.slug-group-archive-btn')) return;
          toggleSlugGroup(id);
        }}
      >
        <div className="slug-group-row">
          <span className="slug-group-expand" dangerouslySetInnerHTML={HTML.arrow} />
          <div className="slug-group-info">
            <div className="slug-group-name">{groupDisplayName(group)}</div>
            <div className="slug-group-meta">
              <span className={'slug-group-dot' + (promoted.length ? ' running' : '')} />
              {projectPath && !projectPath.startsWith('ssh://')
                ? <RepoLink path={projectPath}>{projectLabel(projectPath)}</RepoLink>
                : <span className="session-project">{projectLabel(projectPath)}</span>}
              <span className="slug-group-count">{sessions.length} sessions</span>
              {' ' + formatDate(new Date(newest.modified), now)}
            </div>
          </div>
          <button
            className="slug-group-archive-btn"
            title="Archive all sessions in group"
            dangerouslySetInnerHTML={HTML.archive14}
            onClick={(e) => {
              e.stopPropagation();
              if (el.current) archiveGroup(el.current, id, sessions.map(r => r.session.sessionId), e.currentTarget);
            }}
          />
        </div>
      </div>
      <div className="slug-group-sessions">
        {promoted.length === 0
          ? sessions.map(row => <SessionItem key={row.id} row={row} groupId={id} />)
          : (
            <>
              {promoted.map(row => <SessionItem key={row.id} row={row} groupId={id} />)}
              {rest.length > 0 && (
                <>
                  <div
                    className={'slug-group-more' + (moreCursor ? ' kbd-cursor' : '')}
                    id={'sgm-' + id}
                    onClick={() => expandSlugGroup(id)}
                  >
                    {`+ ${rest.length} more`}
                  </div>
                  <div className="slug-group-older" id={'sgo-' + id}>
                    {rest.map(row => <SessionItem key={row.id} row={row} groupId={id} />)}
                  </div>
                </>
              )}
            </>
          )}
      </div>
    </div>
  );
}
