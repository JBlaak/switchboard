/**
 * The sidebar's pull request list's work outside React: reading your open
 * PRs while the list is shown.
 *
 * Once as the sidebar flips to Pull requests, then every minute while it
 * stays there and the window is watched (`setWatchedInterval`, so a window
 * in the background spends none of GitHub's GraphQL budget, and one coming
 * back reads at once). Main keeps the answer 30 s, so a flip back and forth
 * asks GitHub nothing new. The lanes need no read: main pushes them.
 */
import {getState, store} from '../../state/app-store';
import {setWatchedInterval} from '../../lib/watched-interval';
import {readPullRequests} from './actions';

/** How often the shown list reads your open PRs again. */
export const PR_LIST_READ_MS = 60_000;

/** Start following the sidebar's page. Answers a teardown. */
export function installSidebarPrs(): () => void {
    let stopPoll: (() => void) | null = null;
    const follow = (shown: boolean): void => {
        if (shown && !stopPoll) {
            void readPullRequests();
            stopPoll = setWatchedInterval(() => {
                if (getState().sidebarPage.page === 'pullRequests') void readPullRequests();
            }, PR_LIST_READ_MS);
        } else if (!shown && stopPoll) {
            stopPoll();
            stopPoll = null;
        }
    };
    follow(getState().sidebarPage.page === 'pullRequests');
    const unsubscribe = store.subscribe((state, previous) => {
        if (state.sidebarPage.page !== previous.sidebarPage.page) follow(state.sidebarPage.page === 'pullRequests');
    });
    return () => {
        unsubscribe();
        stopPoll?.();
    };
}
