/**
 * Which plan the view shows (W2). With several, one segment per plan; with
 * none, the repository's open plans to pick from (W3).
 */
import type { JSX } from 'react';
import { sameIssue } from '../../../../domain/plan/model';
import type { IssueKey, Plan, PlanSummary } from '../../../../domain/plan/model';
import { shortTitle, summaryLine } from './describe';
import type { PlanHandlers } from './types';

export function PlanSwitcher(
  { plans, shown, on }: { plans: readonly Plan[]; shown: IssueKey; on: PlanHandlers },
): JSX.Element {
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
            onClick={() => on.choose(plan)}
          >
            {'#' + plan.number + ' ' + shortTitle(plan.title, 24)}
          </button>
        );
      })}
    </div>
  );
}

/** No plan for this session: the repository's open plans (W2, W3). */
export function OtherPlans({ others, on }: { others: readonly PlanSummary[]; on: PlanHandlers }): JSX.Element {
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
          {others.map(summary => (
            <li key={summary.repository + '#' + summary.number}>
              <button type="button" className="pv-other" onClick={() => on.pickOther?.(summary)} disabled={!on.pickOther}>
                <span className="pv-num">{'#' + summary.number}</span>
                <span className="pv-other-title">{summary.title}</span>
                <span className="pv-other-line">{summaryLine(summary)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
