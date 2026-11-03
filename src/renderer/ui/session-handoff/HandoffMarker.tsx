/**
 * The row's "Waiting…" or "Handing off…" marker while a session's hand-off
 * is in flight (#276 stage 3), whether or not its dialog is open.
 */
import {useStore} from '../use-store';
import {sessionRunIn} from '../../state/session-handoff-slice';
import {rowHandoffMarker, rowHandoffTitle} from '../dialogs/session-handoff-view';
import type {JSX} from 'react';

export function HandoffMarker({sessionId}: {sessionId: string}): JSX.Element | null {
    const run = useStore((state) => sessionRunIn(state.sessionHandoff, sessionId));
    const marker = rowHandoffMarker(run);
    if (!marker) return null;
    return (
        <span className="session-handoff-marker" title={rowHandoffTitle(run) ?? undefined}>
            {marker}
        </span>
    );
}
