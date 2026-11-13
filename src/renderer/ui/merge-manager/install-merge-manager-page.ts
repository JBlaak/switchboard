/**
 * The Merge manager page's work outside React (#439): what it shows besides
 * the lanes (CI saved, the errands, the checkouts) is asked for as it opens,
 * and again on every change to the lanes while it is on screen.
 */
import {store} from '../../state/app-store';
import {loadMergeManagerPage} from './page-actions';

/** Start following the route. Answers a teardown. */
export function installMergeManagerPage(): () => void {
    return store.subscribe((state, previous, event) => {
        const open = state.mainArea.route.kind === 'mergeManager';
        const opened = open && previous.mainArea.route.kind !== 'mergeManager';
        if (opened || (open && event.type === 'mergeManagerChanged')) void loadMergeManagerPage();
    });
}
