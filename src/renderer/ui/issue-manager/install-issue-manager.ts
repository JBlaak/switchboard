/**
 * The Issue manager page's work outside React (#415): its items are asked
 * for as it opens, and again on every change to the inbox while it is on
 * screen (a poll, a woken snooze, a stage moved on).
 */
import {store} from '../../state/app-store';
import {loadIssueItems} from './actions';

/** Start following the route. Answers a teardown. */
export function installIssueManager(): () => void {
    return store.subscribe((state, previous, event) => {
        const open = state.mainArea.route.kind === 'issueManager';
        const opened = open && previous.mainArea.route.kind !== 'issueManager';
        if (opened || (open && event.type === 'inboxChanged')) void loadIssueItems();
    });
}
