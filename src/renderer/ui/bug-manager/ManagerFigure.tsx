/**
 * A manager Patch from `@jblaak/patch` (#409): the Bug manager's head on its
 * page (#414), posed by its counts: calm with nothing unread, its prop up
 * while anything is, frantic while something unread trends or regressed;
 * and the Merge manager's on its page (#439), posed by its lanes.
 */
import {useEffect, useRef, type JSX} from 'react';
import {mountManager, type ManagerHandle, type ManagerScene} from '@jblaak/patch';
import '@jblaak/patch/manager.css';
import type {ManagerCounts} from '../../../domain/inbox/model';

/** The inbox managers, posed by their counts. */
export function ManagerFigure({kind, counts}: {kind: 'bug' | 'issue'; counts: ManagerCounts}): JSX.Element {
    const state = counts.urgent > 0 ? 'urgent' : counts.unread > 0 ? 'unread' : 'calm';
    return <SceneFigure scene={{kind, state, count: counts.unread, label: ''}} />;
}

/**
 * Any manager in a scene of its own: the Merge manager's head on its page
 * (#439) is posed by its lanes (`mergeFigureOf`).
 */
export function SceneFigure({scene}: {scene: ManagerScene}): JSX.Element {
    const host = useRef<HTMLDivElement>(null);
    const handle = useRef<ManagerHandle | null>(null);

    useEffect(() => {
        handle.current = mountManager(host.current!);
        return () => {
            handle.current?.destroy();
            handle.current = null;
        };
    }, []);

    const {kind, state, count} = scene;
    useEffect(() => {
        handle.current?.show({kind, state, count, label: ''} as ManagerScene);
    }, [kind, state, count]);

    return <div ref={host} className="bm-figure" />;
}
