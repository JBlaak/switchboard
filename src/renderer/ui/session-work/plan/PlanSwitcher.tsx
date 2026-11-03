/**
 * Which plan the view shows (W2). With several, one segment per plan; with
 * none, the repository's open plans to pick from (W3).
 */
import type {JSX} from 'react';
import {sameIssue} from '../../../../domain/plan/model';
import type {IssueKey, Plan, PlanSummary} from '../../../../domain/plan/model';
import {shortTitle, summaryLine} from './describe';
import type {PlanHandlers, PlanLiveSessions} from './types';
import {PlanLiveMark} from './PlanLiveMark';

export function PlanSwitcher({
    plans,
    shown,
    on,
    live,
}: {
    plans: readonly Plan[];
    shown: IssueKey;
    on: PlanHandlers;
    live?: PlanLiveSessions | null;
}): JSX.Element {
    return (
        <div className="pv-switcher" role="group" aria-label="Plan">
            {plans.map((plan) => {
                const current = sameIssue(plan, shown);
                return (
                    <button
                        key={plan.repository + '#' + plan.number}
                        type="button"
                        className={'pv-seg' + (current ? ' is-current' : '')}
                        aria-pressed={current}
                        title={plan.title}
                        onClick={() => on.choose(plan)}>
                        {'#' + plan.number + ' ' + shortTitle(plan.title, 24)}
                        <PlanLiveMark plan={plan} live={live} compact />
                    </button>
                );
            })}
        </div>
    );
}

/** No plan for this session: the repository's open plans (W2, W3). */
export function OtherPlans({
    others,
    on,
    live,
}: {
    others: readonly PlanSummary[];
    on: PlanHandlers;
    live?: PlanLiveSessions | null;
}): JSX.Element {
    return (
        <div className="pv-others">
            <h2 className="pv-others-title">No plan for this session</h2>
            <p className="pv-others-text">
                {others.length
                    ? 'None of its issues has a parent issue. These are the repository’s open plans:'
                    : 'None of its issues has a parent issue, and the repository has no open plans.'}
            </p>
            {others.length > 0 && (
                <ul className="pv-others-list" aria-label="Open plans">
                    {others.map((summary) => (
                        <li key={summary.repository + '#' + summary.number}>
                            <button
                                type="button"
                                className="pv-other"
                                onClick={() => on.pickOther?.(summary)}
                                disabled={!on.pickOther}>
                                <span className="pv-num">{'#' + summary.number}</span>
                                <span className="pv-other-title">{summary.title}</span>
                                <PlanLiveMark plan={summary} live={live} />
                                <span className="pv-other-line">{summaryLine(summary)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
