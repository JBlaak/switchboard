/**
 * The plan view drawn from props alone: no store, no IPC. `PlanView` wires it
 * to the plan slice; the tests render this directly.
 */
import { useMemo } from 'react';
import type { JSX } from 'react';
import { layOutPlan } from '../../../../domain/plan/layout';
import { sameIssue } from '../../../../domain/plan/model';
import type { IssueKey, Plan } from '../../../../domain/plan/model';
import { PlanHeader } from './PlanHeader';
import { OtherPlans, PlanSwitcher } from './PlanSwitcher';
import { PlanWarnings } from './PlanWarnings';
import { PlanDiagram, PlanLegend } from './PlanDiagram';
import { IssueDetail } from './IssueDetail';
import { LevelStart } from './LevelStart';
import { NO_HANDLERS, NO_PLAN_UI } from './types';
import type { IssueActions, PlanData, PlanHandlers, PlanPinControl, PlanUi } from './types';

export type PlanViewProps = PlanData & { readonly issueActions?: IssueActions; readonly pin?: PlanPinControl };

export function PlanViewContent(
  props: PlanViewProps & {
    readonly ui?: PlanUi; readonly on?: PlanHandlers;
    /** Issues a level-up just made Ready (A4). */
    readonly arriving?: readonly IssueKey[];
  },
): JSX.Element {
  const ui = props.ui ?? NO_PLAN_UI;
  const on = props.on ?? NO_HANDLERS;
  const plans: readonly Plan[] = 'plan' in props ? [props.plan] : props.sessionPlans.plans;
  const plan = (ui.chosen && plans.find(candidate => sameIssue(candidate, ui.chosen!))) || plans[0] || null;
  const layout = useMemo(() => (plan ? layOutPlan(plan) : null), [plan]);

  if (!plan || !layout) {
    const others = 'sessionPlans' in props ? props.sessionPlans.others : [];
    return (
      <div className="pv">
        <OtherPlans others={others} on={on} />
      </div>
    );
  }

  const selected = ui.selected ? plan.issues.find(issue => sameIssue(issue, ui.selected!)) ?? null : null;

  return (
    <div className={'pv' + (selected ? ' has-detail' : '')}>
      {(plans.length > 1 || on.back) && (
        <div className="pv-bar">
          {on.back && (
            <button type="button" className="pv-pill" onClick={on.back}>← This session’s plans</button>
          )}
          <span className="pv-bar-gap" />
          {plans.length > 1 && <PlanSwitcher plans={plans} shown={plan} on={on} />}
        </div>
      )}
      <div className="pv-body">
        <div className="pv-scroll" data-testid="plan-scroll">
          <PlanHeader plan={plan} layout={layout} on={on} pin={props.pin} />
          <PlanWarnings plan={plan} layout={layout} />
          <LevelStart plan={plan} issueActions={props.issueActions} />
          {plan.issues.length
            ? <PlanDiagram plan={plan} layout={layout} ui={ui} on={on} issueActions={props.issueActions} arriving={props.arriving} />
            : <div className="pv-none pv-empty">This plan has no sub-issues yet.</div>}
          {plan.issues.length > 0 && <PlanLegend />}
        </div>
        {selected && (
          <IssueDetail plan={plan} layout={layout} issue={selected} on={on} issueActions={props.issueActions} />
        )}
      </div>
    </div>
  );
}
