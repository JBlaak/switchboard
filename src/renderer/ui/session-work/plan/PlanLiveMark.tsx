/**
 * The mark on a plan with a Claude session running on this Mac: one that owns
 * the plan or any of its issues (S1) and whose terminal is alive. A pill with
 * the count in the header and the list of other plans, a dot in a switcher
 * segment; nothing when none runs, or when the view was given no sessions.
 */
import type {JSX} from 'react';
import {runningOnPlan} from '../../../../domain/plan/issue-session';
import type {IssueKey} from '../../../../domain/plan/model';
import type {PlanLiveSessions} from './types';

/** `1 Claude session running on this Mac`. */
export function liveText(count: number): string {
    return count + ' Claude session' + (count === 1 ? '' : 's') + ' running on this Mac';
}

export function PlanLiveMark({
    plan,
    live,
    compact = false,
}: {
    plan: IssueKey & {readonly issues?: readonly IssueKey[]};
    live?: PlanLiveSessions | null;
    /** A dot alone, for a switcher segment. */
    compact?: boolean;
}): JSX.Element | null {
    if (!live) return null;
    const count = runningOnPlan(plan, live.owners, live.running).length;
    if (count === 0) return null;
    const text = liveText(count);
    if (compact) return <span className="pv-live is-dot" role="img" aria-label={text} title={text} />;
    return (
        <span className="pv-live" title={text} data-testid="plan-live">
            <span className="pv-live-dot" aria-hidden="true" />
            {count} running
        </span>
    );
}
