/**
 * A GitHub plan pinned from its page: one row under Pinned plans that opens
 * the plan's page in its project, and whose pin unpins it. Its project's name
 * opens the project page (⌘-click GitHub), as on a session row.
 *
 * It has no sessions of its own, so none of a session row's live state or
 * buttons; the title is the one stored when it was pinned. Progress that is
 * out of date is dimmed, with why in its tooltip (`pinned-plan-freshness`).
 */
import {projectLabel} from '../../features/sessions/project-label';
import {projectPlan} from '../../state/main-area-slice';
import {useStore} from '../use-store';
import {openPlanPage} from '../plan-page/actions';
import {toggleIssuePlanPin} from './actions';
import {HTML} from './markup';
import {ProjectLink} from '../project-page/ProjectLink';
import {useEffect, type JSX} from 'react';
import {issueKeyString} from '../../../domain/plan/model';
import {progressCounts, type PlanProgress} from '../../../domain/plan/plan-progress';
import {followPinnedPlan} from './pinned-plan-progress';
import {pinnedPlanStaleText} from './pinned-plan-freshness';
import {FRESHNESS_SEPARATOR} from '../shared/freshness-text';
import type {SessionListPlan} from '../../state/session-list-layout';
import {sameRepository} from '../../../domain/project/repo-url';

export function PinnedPlanItem({plan}: {plan: SessionListPlan}): JSX.Element {
    const {id, projectPath, repository, number, title} = plan;
    const active = useStore((s) => {
        const shown = projectPlan(s.mainArea);
        return (
            !!shown &&
            shown.projectPath === projectPath &&
            sameRepository(shown.repository, repository) &&
            shown.number === number
        );
    });
    const cursor = useStore((s) => s.sessionList.cursor === id);
    const planKey = issueKeyString({repository, number});
    const progress = useStore((s) => s.plan.progress[planKey]);
    const stale = useStore((s) =>
        pinnedPlanStaleText(s.plan.progressReads[planKey], s.sessionList.now || Date.now(), s.github.heldUntil),
    );
    useEffect(() => followPinnedPlan({repository, number}), [repository, number]);

    return (
        <div
            className={'session-item pinned-plan-item' + (active ? ' active' : '') + (cursor ? ' kbd-cursor' : '')}
            id={id}
            onClick={() => openPlanPage({projectPath, repository, number})}>
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
                            <ProjectLink
                                path={projectPath}
                                className={'session-project' + (projectPath.startsWith('ssh://') ? ' is-remote' : '')}>
                                {projectLabel(projectPath)}
                            </ProjectLink>
                            <span className="session-time">{'#' + number}</span>
                        </span>
                    </div>
                    {progress && <PinnedPlanProgress progress={progress} stale={stale} />}
                </div>
            </div>
        </div>
    );
}

/**
 * The plan's level, a bar with one segment per level sized by its issues
 * coloured like the plan view's nodes (closed in purple, with a PR in orange,
 * ready to start in green, blocked in gray), and closed / all issues. When
 * `stale` says why it is out of date, the whole line dims and says so on hover.
 */
function PinnedPlanProgress({progress, stale}: {progress: PlanProgress; stale: string | null}): JSX.Element {
    const {done, total} = progressCounts(progress);
    const level =
        progress.current === null
            ? 'Cleared'
            : 'Level ' + progress.current + (progress.levels.length > 1 ? ' of ' + progress.levels.length : '');
    return (
        <div
            className={'pinned-plan-progress' + (stale ? ' is-stale' : '')}
            data-testid="pinned-plan-progress"
            title={stale ?? undefined}>
            <span className={'pinned-plan-level' + (progress.current === null ? ' is-cleared' : '')}>{level}</span>
            <span className="pinned-plan-bar" aria-hidden="true">
                {progress.levels.map((l, i) => (
                    <span key={i} className="pinned-plan-segment" style={{flexGrow: Math.max(l.total, 1)}}>
                        <span className="is-done" style={{width: pct(l.done, l.total)}} />
                        <span className="is-started" style={{width: pct(l.started, l.total)}} />
                        <span className="is-ready" style={{width: pct(l.ready, l.total)}} />
                    </span>
                ))}
            </span>
            <span
                className="pinned-plan-count"
                title={done + ' of ' + total + ' issues closed' + (stale ? FRESHNESS_SEPARATOR + stale : '')}>
                {done + '/' + total}
            </span>
        </div>
    );
}

function pct(part: number, whole: number): string {
    return whole ? (part / whole) * 100 + '%' : '0%';
}
