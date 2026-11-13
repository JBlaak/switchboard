/**
 * The managers on the empty screen (#416, #440): four in a row on the family
 * card's floor, the Bug manager, Patch, the Issue manager and the Merge
 * manager.
 *
 * The inbox managers stand there only once they are set up (main says so
 * with the inbox counts); their pose and unread tag follow the counts as main
 * pushes them (`managerFigureOf`). The Merge manager always stands there,
 * idle with nothing landed; its pose and peach Needs you tag follow the lanes
 * (`mergeFigureOf`), and its bubble says what merged lately (`mergedBubble`).
 * Choosing a manager, by click or by focus and Enter, opens its page. Patch
 * gets a name label too, so the four read as a row.
 *
 * Where they stand is the stylesheet's: on the floor beside Patch, or beside
 * the ask box in a window too short for the family card. Like Patch, each
 * figure is the package's imperative handle mounted from an effect.
 */
import {useEffect, useRef, useState} from 'react';
import {mountManager} from '@jblaak/patch';
import '@jblaak/patch/manager.css';
import {mergeFigureOf, mergedBubble, mergedBubbleExpiry} from '../../../domain/merge-manager/figure';
import {managerFigureOf} from '../../state/inbox-slice';
import {openManagerPage, openMergeManagerPage} from '../inbox/actions';
import {useStore} from '../use-store';
import type {JSX} from 'react';
import type {ManagerHandle, ManagerScene} from '@jblaak/patch';
import type {MergeFigure} from '../../../domain/merge-manager/figure';
import type {MergeManagerState} from '../../../domain/merge-manager/model';
import type {ManagerFigure} from '../../state/inbox-slice';

function sameFigure(a: ManagerFigure | null, b: ManagerFigure | null): boolean {
    return a === b || (a !== null && b !== null && a.pose === b.pose && a.count === b.count);
}

function sameMergeFigure(a: MergeFigure, b: MergeFigure): boolean {
    return a.pose === b.pose && a.count === b.count;
}

export function EmptyScreenManagers(): JSX.Element {
    const bug = useStore((state) => managerFigureOf(state.inbox, 'bug'), sameFigure);
    const issue = useStore((state) => managerFigureOf(state.inbox, 'issue'), sameFigure);
    const merge = useStore((state) => mergeFigureOf(state.mergeManager.state), sameMergeFigure);
    const lanes = useStore((state) => state.mergeManager.state);
    return (
        <div className="placeholder-managers" data-testid="patch-managers">
            {bug && (
                <Manager
                    kind="bug"
                    scene={{kind: 'bug', state: bug.pose, count: bug.count}}
                    onSelect={() => openManagerPage('bug')}
                />
            )}
            <span className="placeholder-patch-label" aria-hidden="true">
                Ask Patch
            </span>
            {issue && (
                <Manager
                    kind="issue"
                    scene={{kind: 'issue', state: issue.pose, count: issue.count}}
                    onSelect={() => openManagerPage('issue')}
                />
            )}
            <Manager
                kind="merge"
                scene={{kind: 'merge', state: merge.pose, count: merge.count}}
                onSelect={openMergeManagerPage}>
                <MergedBubble lanes={lanes} />
            </Manager>
        </div>
    );
}

function Manager({
    kind,
    scene,
    onSelect,
    children,
}: {
    kind: ManagerScene['kind'];
    scene: ManagerScene;
    onSelect: () => void;
    children?: JSX.Element;
}): JSX.Element {
    const slot = useRef<HTMLDivElement>(null);
    const handle = useRef<ManagerHandle | null>(null);
    const select = useRef(onSelect);
    select.current = onSelect;

    useEffect(() => {
        const manager = mountManager(slot.current!, {onSelect: () => select.current()});
        handle.current = manager;
        return () => {
            handle.current = null;
            manager.destroy();
        };
    }, [kind]);

    const {state, count} = scene;
    useEffect(() => {
        handle.current?.show(scene);
        // The scene is rebuilt on every render; only what it says matters.
    }, [kind, state, count]);

    return (
        <div ref={slot} className={`placeholder-manager is-${kind}`} data-manager={kind} data-state={state}>
            {children}
        </div>
    );
}

/** What merged lately, over the Merge manager's head; it goes when the last of those merges ages out. */
function MergedBubble({lanes}: {lanes: MergeManagerState}): JSX.Element | null {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        setNow(Date.now());
    }, [lanes]);
    const expiry = mergedBubbleExpiry(lanes, now);
    useEffect(() => {
        if (expiry === null) return;
        const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiry - Date.now()) + 50);
        return () => clearTimeout(timer);
    }, [expiry]);
    const text = mergedBubble(lanes, now);
    if (!text) return null;
    return (
        <span className="placeholder-manager-bubble" role="status">
            {text}
        </span>
    );
}
