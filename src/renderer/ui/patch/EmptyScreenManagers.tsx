/**
 * The managers on the empty screen (#416): the Bug manager to Patch's left
 * and the Issue manager to its right, all three on the family card's floor.
 *
 * Each stands there only once it is set up (main says so with the inbox
 * counts), so with neither the empty screen is as it always was. The pose and
 * the unread tag follow the counts as main pushes them (`managerFigureOf`).
 * Choosing a manager, by click or by focus and Enter, opens its page. With
 * any manager out, Patch gets a name label too, so the three read as a row.
 *
 * Where they stand is the stylesheet's: on the floor beside Patch, or beside
 * the ask box in a window too short for the family card. Like Patch, each
 * figure is the package's imperative handle mounted from an effect.
 */
import {useEffect, useRef} from 'react';
import {mountManager} from '@jblaak/patch';
import '@jblaak/patch/manager.css';
import {managerFigureOf} from '../../state/inbox-slice';
import {openManagerPage} from '../inbox/actions';
import {useStore} from '../use-store';
import type {JSX} from 'react';
import type {ManagerHandle} from '@jblaak/patch';
import type {InboxManager} from '../../../domain/inbox/model';
import type {ManagerFigure} from '../../state/inbox-slice';

function sameFigure(a: ManagerFigure | null, b: ManagerFigure | null): boolean {
    return a === b || (a !== null && b !== null && a.pose === b.pose && a.count === b.count);
}

export function EmptyScreenManagers(): JSX.Element | null {
    const bug = useStore((state) => managerFigureOf(state.inbox, 'bug'), sameFigure);
    const issue = useStore((state) => managerFigureOf(state.inbox, 'issue'), sameFigure);
    if (!bug && !issue) return null;
    return (
        <div className="placeholder-managers" data-testid="patch-managers">
            {bug && <Manager kind="bug" figure={bug} />}
            <span className="placeholder-patch-label" aria-hidden="true">
                Ask Patch
            </span>
            {issue && <Manager kind="issue" figure={issue} />}
        </div>
    );
}

function Manager({kind, figure}: {kind: InboxManager; figure: ManagerFigure}): JSX.Element {
    const slot = useRef<HTMLDivElement>(null);
    const handle = useRef<ManagerHandle | null>(null);

    useEffect(() => {
        const manager = mountManager(slot.current!, {onSelect: () => openManagerPage(kind)});
        handle.current = manager;
        return () => {
            handle.current = null;
            manager.destroy();
        };
    }, [kind]);

    useEffect(() => {
        handle.current?.show({kind, state: figure.pose, count: figure.count});
    }, [kind, figure]);

    return <div ref={slot} className={`placeholder-manager is-${kind}`} data-manager={kind} />;
}
