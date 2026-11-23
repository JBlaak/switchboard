/**
 * The create-a-schedule dialog outside React: as it opens from a session,
 * Claude is asked for the draft (once, not again under StrictMode's doubled
 * effects); and the schedules are read for its Copy of… starters when nothing
 * has read them yet.
 */
import {onEvent} from '../../state/app-store';
import {draftFromSession, loadSchedulesForCopies} from './create-actions';

/** Start following. Answers a teardown. */
export function installScheduleCreate(): () => void {
    return onEvent('scheduleCreateRequested', (event) => {
        if (event.sessionId) void draftFromSession(event.sessionId);
        void loadSchedulesForCopies();
    });
}
