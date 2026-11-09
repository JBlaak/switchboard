/**
 * A project pinned from its page: one row under Pinned projects, above the
 * pinned plans, that opens the project's page, and whose pin unpins it.
 *
 * Its sessions stay where they are in the list; the row is only a way into
 * the page, so it has none of a session row's live state or buttons.
 */
import {projectLabel} from '../../features/sessions/project-label';
import {projectRoute} from '../../state/main-area-slice';
import {useStore} from '../use-store';
import {openProjectPage} from '../project-page/actions';
import {toggleProjectPin} from './actions';
import {HTML} from './markup';
import type {JSX} from 'react';
import type {SessionListProject} from '../../state/session-list-layout';

export function PinnedProjectItem({project}: {project: SessionListProject}): JSX.Element {
    const {id, projectPath} = project;
    // Lit while the page shows the project itself, not one of its plans, which has its own row.
    const active = useStore((s) => {
        const route = projectRoute(s.mainArea);
        return !!route && route.projectPath === projectPath && route.view.kind !== 'plan';
    });
    const cursor = useStore((s) => s.sessionList.cursor === id);

    return (
        <div
            className={'session-item pinned-project-item' + (active ? ' active' : '') + (cursor ? ' kbd-cursor' : '')}
            id={id}
            data-testid="pinned-project"
            onClick={() => openProjectPage(projectPath)}>
            <div className="session-row">
                <span
                    className="session-pin pinned"
                    data-testid="project-pin"
                    title="Unpin project"
                    dangerouslySetInnerHTML={HTML.pinFilled}
                    onClick={(e) => {
                        e.stopPropagation();
                        void toggleProjectPin(projectPath, e.currentTarget);
                    }}
                />
                {/* No session, so no dot: its place is kept so the title lines up with the rows'. */}
                <span className="session-status-dot is-spacer" aria-hidden="true" />
                <div className="session-info">
                    <div className="session-summary">{projectLabel(projectPath)}</div>
                    <div className="session-meta">
                        <span className="pinned-project-path" title={projectPath}>
                            {projectPath}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
