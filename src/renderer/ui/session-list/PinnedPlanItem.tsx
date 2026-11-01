/**
 * A GitHub plan pinned from its page: one row under Pinned plans that opens
 * the plan's page in its project, and whose pin unpins it.
 *
 * It has no sessions of its own, so none of a session row's live state or
 * buttons; the title is the one stored when it was pinned.
 */
import { projectLabel } from '../../features/sessions/project-label';
import { projectPlan } from '../../state/main-area-slice';
import { useStore } from '../use-store';
import { openPlanPage } from '../plan-page/actions';
import { toggleIssuePlanPin } from './actions';
import { HTML } from './markup';
import type { JSX } from 'react';
import type { SessionListPlan } from '../../state/session-list-layout';

export function PinnedPlanItem({ plan }: { plan: SessionListPlan }): JSX.Element {
  const { id, projectPath, repository, number, title } = plan;
  const active = useStore(s => {
    const shown = projectPlan(s.mainArea);
    return !!shown && shown.projectPath === projectPath && shown.repository === repository && shown.number === number;
  });
  const cursor = useStore(s => s.sessionList.cursor === id);

  return (
    <div
      className={'session-item pinned-plan-item' + (active ? ' active' : '') + (cursor ? ' kbd-cursor' : '')}
      id={id}
      onClick={() => openPlanPage({ projectPath, repository, number })}
    >
      <div className="session-row">
        <span
          className="session-pin pinned"
          data-testid="issue-plan-pin"
          title="Unpin plan"
          dangerouslySetInnerHTML={HTML.pinFilled}
          onClick={(e) => {
            e.stopPropagation();
            void toggleIssuePlanPin(projectPath, plan, e.currentTarget);
          }}
        />
        {/* No session, so no dot: its place is kept so the title lines up with the rows'. */}
        <span className="session-status-dot is-spacer" aria-hidden="true" />
        <div className="session-info">
          <div className="session-summary">{title}</div>
          <div className="session-meta">
            <span className="session-meta-left">
              <span className="session-project">{projectLabel(projectPath)}</span>
              <span className="session-time">{'#' + number}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
