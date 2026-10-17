/**
 * The plan view (W1, F2): the switcher, the header, the warnings, the flow
 * diagram and the issue's detail, for a session's plans or for one plan given
 * directly. It knows nothing about the page around it: the Session work page
 * shows it as its Plan tab, and #128 in the main area without a session.
 *
 * `PlanViewContent` draws it from props alone (and is what the tests render);
 * `PlanView` is the same view wired to the plan slice for what is hovered and
 * selected, and to `plan/load` for what it does.
 */
import type { JSX } from 'react';
import { useStore } from '../../use-store';
import { shallowEqual } from '../../../state/store';
import { planHandlers } from './load';
import { NO_PLAN_UI } from './types';
import { PlanViewContent } from './PlanViewContent';
import type { PlanViewProps } from './PlanViewContent';

export type { PlanViewProps };

/** The plan view, wired to the plan slice. */
export function PlanView(props: PlanViewProps): JSX.Element {
  const ui = useStore(
    state => {
      const view = state.plan.view;
      return view ? { chosen: view.chosen, hovered: view.hovered, selected: view.selected } : NO_PLAN_UI;
    },
    shallowEqual,
  );
  const canGoBack = useStore(state => !!state.plan.view?.from);
  const on = canGoBack ? planHandlers : { ...planHandlers, back: undefined };
  return <PlanViewContent {...props} ui={ui} on={on} />;
}
