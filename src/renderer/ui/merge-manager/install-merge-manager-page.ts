/**
 * The Merge manager page's work outside React (#439): what it shows besides
 * the lanes (CI saved, the errands, the checkouts) and your open PRs for Not
 * landed are asked for as it opens, and again on every change to the lanes
 * while it is on screen (main keeps the open PRs for 30 s, so no throttle).
 * A push from this Mac that only says how fresh the lanes are (each poll's
 * start and end) is no change to them; a VM's lanes are pushed after each
 * read of it, and each such push still asks again, as it always did.
 */
import {store} from '../../state/app-store';
import {loadMergeManagerPage} from './page-actions';
import {loadNotLanded} from './not-landed-actions';
import {lanesChanged} from '../../state/merge-manager-slice';

/** Start following the route. Answers a teardown. */
export function installMergeManagerPage(): () => void {
    return store.subscribe((state, previous, event) => {
        const open = state.mainArea.route.kind === 'mergeManager';
        const opened = open && previous.mainArea.route.kind !== 'mergeManager';
        const changed =
            event.type === 'mergeManagerChanged' && lanesChanged(previous.mergeManager.state, state.mergeManager.state);
        if (opened || (open && changed)) {
            void loadMergeManagerPage();
            void loadNotLanded();
        }
    });
}
