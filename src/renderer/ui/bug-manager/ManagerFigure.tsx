/**
 * A manager Patch from `@jblaak/patch` (#409): the Bug manager's head on its
 * page (#414), posed by its counts: calm with nothing unread, its prop up
 * while anything is, frantic while something unread trends or regressed.
 */
import {useEffect, useRef, type JSX} from 'react';
import {mountManager, type ManagerHandle, type ManagerKind} from '@jblaak/patch';
import '@jblaak/patch/manager.css';
import type {ManagerCounts} from '../../../domain/inbox/model';

export function ManagerFigure({kind, counts}: {kind: ManagerKind; counts: ManagerCounts}): JSX.Element {
    const host = useRef<HTMLDivElement>(null);
    const handle = useRef<ManagerHandle | null>(null);

    useEffect(() => {
        handle.current = mountManager(host.current!);
        return () => {
            handle.current?.destroy();
            handle.current = null;
        };
    }, []);

    useEffect(() => {
        const state = counts.urgent > 0 ? 'urgent' : counts.unread > 0 ? 'unread' : 'calm';
        handle.current?.show({kind, state, count: counts.unread, label: ''});
    }, [kind, counts.unread, counts.urgent]);

    return <div ref={host} className="bm-figure" />;
}
