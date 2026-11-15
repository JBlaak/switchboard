/**
 * The Merge manager page's work outside React (#439): what it shows besides
 * the lanes (CI saved, the errands, the checkouts) and your open PRs for Not
 * landed are asked for as it opens, and again on every change to the lanes
 * while it is on screen (main keeps the open PRs for 30 s, so no throttle).
 */
import {store} from '../../state/app-store';
import {loadMergeManagerPage} from './page-actions';
import {loadNotLanded} from './not-landed-actions';

/** Start following the route. Answers a teardown. */
export function installMergeManagerPage(): () => void {
    return store.subscribe((state, previous, event) => {
        const open = state.mainArea.route.kind === 'mergeManager';
        const opened = open && previous.mainArea.route.kind !== 'mergeManager';
        if (opened || (open && event.type === 'mergeManagerChanged')) {
            void loadMergeManagerPage();
            void loadNotLanded();
        }
    });
}
