/**
 * The New Session picker's plan list (F1, F3): one project's plans, each with
 * its level and how much is closed, then Show closed, or the closed plans
 * dimmed once it was chosen. The picker keeps the highlight and the keys;
 * this only draws the rows.
 */
import type { JSX, Ref } from 'react';
import type { PlanSummary } from '../../../domain/plan/model';
import { planClosedLabel, planLevelLabel, planLevelSegments } from './plan-list';

/** A row of the plan list: a plan, or the Show closed row. */
export type PlanPickerItem =
  | { readonly kind: 'plan'; readonly plan: PlanSummary }
  | { readonly kind: 'show-closed' };

/** Where the project's plans are. */
export type PickerPlansState =
  | { readonly phase: 'loading' }
  /** `projectPlans` answered null: why there are none to show. */
  | { readonly phase: 'unavailable'; readonly reason: string }
  | {
    readonly phase: 'loaded';
    readonly open: readonly PlanSummary[];
    /** Null until Show closed was chosen. */
    readonly closed: readonly PlanSummary[] | null;
    readonly closedLoading: boolean;
  };

export interface PickerPlansProps {
  state: PickerPlansState;
  items: readonly PlanPickerItem[];
  selected: number;
  /** The filter has text: an empty list says nothing matched rather than that there are none. */
  filtered: boolean;
  rowRef(index: number): Ref<HTMLDivElement>;
  onHover(index: number): void;
  onActivate(index: number): void;
}

export function PickerPlans({ state, items, selected, filtered, rowRef, onHover, onActivate }: PickerPlansProps): JSX.Element {
  if (state.phase === 'loading') {
    return <div className="project-picker-empty" role="status">Loading plans…</div>;
  }
  if (state.phase === 'unavailable') {
    return <div className="project-picker-empty" role="status">{state.reason}</div>;
  }

  const plans = items.filter(item => item.kind === 'plan').length;
  const firstClosed = items.findIndex(item => item.kind === 'plan' && item.plan.state === 'closed');

  return (
    <>
      {plans === 0 && (
        <div className="project-picker-empty">
          {filtered ? 'No matching plans.' : state.closed ? 'No plans in this project.' : 'No open plans in this project.'}
        </div>
      )}
      {items.map((item, index) => {
        const common = {
          ref: rowRef(index),
          onMouseEnter: () => onHover(index),
          onClick: () => onActivate(index),
        };
        if (item.kind === 'show-closed') {
          return (
            <div key="show-closed" {...common} role="option" aria-selected={index === selected}
              className={'plan-picker-more' + (index === selected ? ' selected' : '')}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M4 6l4 4 4-4" />
              </svg>
              <span>{state.closedLoading ? 'Loading closed plans…' : 'Show closed'}</span>
            </div>
          );
        }
        const { plan } = item;
        const closed = plan.state === 'closed';
        return (
          <PlanRow
            key={plan.repository + '#' + plan.number}
            {...common}
            plan={plan}
            closed={closed}
            selected={index === selected}
            divider={index === firstClosed}
          />
        );
      })}
    </>
  );
}

interface PlanRowProps {
  ref: Ref<HTMLDivElement>;
  plan: PlanSummary;
  closed: boolean;
  selected: boolean;
  /** The first closed plan: a "Closed" heading goes above it. */
  divider: boolean;
  onMouseEnter(): void;
  onClick(): void;
}

function PlanRow({ ref, plan, closed, selected, divider, onMouseEnter, onClick }: PlanRowProps): JSX.Element {
  const segments = planLevelSegments(plan);
  return (
    <>
      {divider && <div className="plan-picker-divider">Closed</div>}
      <div
        ref={ref}
        role="option"
        aria-selected={selected}
        aria-label={'#' + plan.number + ' ' + plan.title}
        className={'plan-picker-row' + (selected ? ' selected' : '') + (closed ? ' is-closed' : '')}
        onMouseEnter={onMouseEnter}
        onClick={onClick}
      >
        <svg className="plan-picker-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          {closed
            ? <path d="M3 8.5 6.5 12 13 4.5" strokeWidth="2" />
            : <><circle cx="4" cy="3.5" r="1.6" /><circle cx="12" cy="8" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><path d="M5.5 4.2 10.5 7.3M5.5 11.8l5-3.1" /></>}
        </svg>
        <span className="plan-picker-main">
          <span className="plan-picker-title">
            <span className="plan-picker-num">{'#' + plan.number}</span>
            <span className="plan-picker-name" title={plan.title}>{plan.title}</span>
          </span>
          {segments.length > 0 && (
            <span className="plan-picker-bar" aria-hidden="true">
              {segments.map((segment, i) => <span key={i} className={'plan-picker-seg is-' + segment} />)}
            </span>
          )}
        </span>
        <span className="plan-picker-stats">
          <span className="plan-picker-level">{planLevelLabel(plan)}</span>
          <span>{planClosedLabel(plan)}</span>
        </span>
      </div>
    </>
  );
}
