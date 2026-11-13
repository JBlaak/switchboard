/**
 * The managers' inbox's launch-time work (#413): read both managers' counts,
 * which main has had since before the window opened; every change after is
 * pushed (`inboxChanged`).
 */
import {dispatch} from '../../state/app-store';

export function installInbox(): void {
    void window.api
        .inboxSummary()
        .then((summary) => dispatch({type: 'inboxChanged', summary}))
        .catch(() => {
            // Main answers on its next change.
        });
}
