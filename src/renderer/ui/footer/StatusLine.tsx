/**
 * Two independent halves on one line: how many sessions are running now, read
 * live from the poll's answer, and the activity line main writes into while it
 * indexes.
 *
 * Both are usually empty; the stylesheet hides the row until one has text.
 */
import {useStore} from '../use-store';
import {runningLabel} from './footer-view';
import type {JSX} from 'react';

export function StatusLine(): JSX.Element {
    const running = useStore((state) => state.view.activePtyIds.size);
    const activity = useStore((state) => state.status.activity);
    return (
        <div id="sidebar-footer-status">
            <span id="sidebar-footer-info">{runningLabel(running)}</span>
            <span id="sidebar-footer-activity" className={activity.done ? 'status-done' : ''}>
                {activity.text}
            </span>
        </div>
    );
}
