/**
 * The Bug manager page's reads (#414): its items as it opens, and again on
 * every change main pushes while it is open (a poll, a Fix that moved on, a
 * snooze that woke).
 */
import {store} from '../../state/app-store';
import {loadBugPage} from './page-actions';

export function installBugPage(): void {
    store.subscribe((state, previous, event) => {
        const open = state.mainArea.route.kind === 'bugs';
        const opened = open && previous.mainArea.route.kind !== 'bugs';
        if (opened || (open && event.type === 'inboxChanged')) void loadBugPage();
    });
}
