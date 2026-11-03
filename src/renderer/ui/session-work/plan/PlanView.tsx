/**
 * The plan view (W1, F2): the switcher, the header, the warnings, the flow
 * diagram and the issue's detail, for a session's plans or for one plan given
 * directly. It knows nothing about the page around it: the Session work page
 * shows it as its Plan tab, and #128 in the main area without a session.
 *
 * `PlanViewContent` draws it from props alone (and is what the tests render);
 * `PlanView` is the same view wired to the plan slice for what is hovered and
 * selected, to `plan/load` for what it does, and plays a level-up the slice
 * queued (`PlanCheer`) in whichever home it is in.
 */
import {useMemo} from 'react';
import type {JSX} from 'react';
import {useStore} from '../../use-store';
import {shallowEqual} from '../../../state/store';
import {planRefresh} from '../../../state/plan-slice';
import {planHandlers} from './load';
import {NO_PLAN_UI} from './types';
import type {PlanLiveSessions} from './types';
import type {IdRecord} from '../../../state/records';
import {PlanViewContent} from './PlanViewContent';
import type {PlanViewProps} from './PlanViewContent';
import {PlanCheer, useCheer} from './PlanCheer';

export type {PlanViewProps};

/** The plan view, wired to the plan slice. */
export function PlanView(props: PlanViewProps): JSX.Element {
    const ui = useStore((state) => {
        const view = state.plan.view;
        return view ? {chosen: view.chosen, hovered: view.hovered, selected: view.selected} : NO_PLAN_UI;
    }, shallowEqual);
    const canGoBack = useStore((state) => !!state.plan.view?.from);
    const on = canGoBack ? planHandlers : {...planHandlers, back: undefined};
    const refresh = useStore((state) => (state.plan.view ? planRefresh(state.plan.view) : null));
    const cheer = useCheer();
    const live = useLiveSessions();
    return (
        <>
            <PlanViewContent {...props} ui={ui} on={on} arriving={cheer?.arriving} refresh={refresh} live={live} />
            {cheer && <PlanCheer cheer={cheer} />}
        </>
    );
}

const NO_OWNERS: IdRecord<string> = {};

/**
 * The view's issue owners (S1) and which of them have a live terminal on this
 * Mac. The poll hands over a new set of running ids every few seconds, so the
 * store is read as a string of the running owners: a poll that changed none of
 * them does not draw the view again.
 */
function useLiveSessions(): PlanLiveSessions {
    const owners = useStore((state) => state.plan.view?.owners ?? NO_OWNERS);
    const runningOwners = useStore((state) =>
        [...new Set(Object.values(state.plan.view?.owners ?? NO_OWNERS))]
            .filter((sessionId) => state.view.activePtyIds.has(sessionId))
            .sort()
            .join(' '),
    );
    return useMemo(
        () => ({owners, running: new Set(runningOwners ? runningOwners.split(' ') : [])}),
        [owners, runningOwners],
    );
}
