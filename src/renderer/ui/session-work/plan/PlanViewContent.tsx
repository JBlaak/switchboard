/**
 * The plan view drawn from props alone: no store, no IPC. `PlanView` wires it
 * to the plan slice; the tests render this directly.
 */
import {useMemo} from 'react';
import type {JSX} from 'react';
import {layOutPlan} from '../../../../domain/plan/layout';
import {sameIssue} from '../../../../domain/plan/model';
import type {IssueKey, Plan} from '../../../../domain/plan/model';
import {PlanHeader} from './PlanHeader';
import {MapLaunchers} from './MapLaunchers';
import {OtherPlans, PlanSwitcher} from './PlanSwitcher';
import {PlanWarnings} from './PlanWarnings';
import {PlanDiagram, PlanLegend} from './PlanDiagram';
import {IssueDetail} from './IssueDetail';
import {LevelStart} from './LevelStart';
import {NO_HANDLERS, NO_PLAN_UI} from './types';
import type {MergeManagerState} from '../../../../domain/merge-manager/model';
import type {
    IssueActions,
    PlanData,
    PlanHandlers,
    PlanLiveSessions,
    PlanPinControl,
    PlanRefresh,
    PlanUi,
} from './types';

export type PlanViewProps = PlanData & {readonly issueActions?: IssueActions; readonly pin?: PlanPinControl};

export function PlanViewContent(
    props: PlanViewProps & {
        readonly ui?: PlanUi;
        readonly on?: PlanHandlers;
        /** Issues a level-up just made Ready (A4). */
        readonly arriving?: readonly IssueKey[];
        /** Showing a stored copy while main is asked again, or after it could not answer (`planRefresh`). */
        readonly refresh?: PlanRefresh | null;
        /** Which sessions own which issues and run on this Mac; absent, no plan is marked. */
        readonly live?: PlanLiveSessions | null;
        /** The Merge manager's lanes, for landed PRs' stages on the nodes (#441); absent, none is landed. */
        readonly merge?: MergeManagerState;
    },
): JSX.Element {
    const ui = props.ui ?? NO_PLAN_UI;
    const on = props.on ?? NO_HANDLERS;
    const plans: readonly Plan[] = 'plan' in props ? [props.plan] : props.sessionPlans.plans;
    const plan = (ui.chosen && plans.find((candidate) => sameIssue(candidate, ui.chosen!))) || plans[0] || null;
    const layout = useMemo(() => (plan ? layOutPlan(plan) : null), [plan]);

    if (!plan || !layout) {
        const others = 'sessionPlans' in props ? props.sessionPlans.others : [];
        return (
            <div className="pv">
                <OtherPlans others={others} on={on} live={props.live} />
            </div>
        );
    }

    const selected = ui.selected ? (plan.issues.find((issue) => sameIssue(issue, ui.selected!)) ?? null) : null;

    return (
        <div className={'pv' + (selected ? ' has-detail' : '')}>
            {(plans.length > 1 || on.back) && (
                <div className="pv-bar">
                    {on.back && (
                        <button type="button" className="pv-pill" onClick={on.back}>
                            ← This session’s plans
                        </button>
                    )}
                    <span className="pv-bar-gap" />
                    {plans.length > 1 && <PlanSwitcher plans={plans} shown={plan} on={on} live={props.live} />}
                </div>
            )}
            <div className="pv-body">
                <div className="pv-scroll" data-testid="plan-scroll">
                    <PlanHeader
                        plan={plan}
                        layout={layout}
                        on={on}
                        pin={props.pin}
                        refresh={props.refresh ?? null}
                        live={props.live ?? null}
                    />
                    <PlanWarnings plan={plan} layout={layout} />
                    <LevelStart plan={plan} issueActions={props.issueActions} />
                    {plan.wayfinder && <MapLaunchers plan={plan} issueActions={props.issueActions} />}
                    {plan.issues.length ? (
                        <PlanDiagram
                            plan={plan}
                            layout={layout}
                            ui={ui}
                            on={on}
                            issueActions={props.issueActions}
                            arriving={props.arriving}
                            merge={props.merge}
                        />
                    ) : (
                        <div className="pv-none pv-empty">
                            {plan.wayfinder ? 'This map has no tickets yet.' : 'This plan has no sub-issues yet.'}
                        </div>
                    )}
                    {plan.issues.length > 0 && <PlanLegend wayfinder={plan.wayfinder === true} />}
                </div>
                {selected && (
                    <IssueDetail
                        plan={plan}
                        layout={layout}
                        issue={selected}
                        on={on}
                        issueActions={props.issueActions}
                    />
                )}
            </div>
        </div>
    );
}
