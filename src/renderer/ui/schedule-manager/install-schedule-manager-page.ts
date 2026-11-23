/**
 * The Schedule manager's work outside React: its facts are read at launch
 * (the figure on the empty screen and the shelf need them before the page
 * opens; every change after is pushed, `scheduleManagerChanged`), and a
 * schedule's page is read as it opens and again on every push while it is
 * on screen, since a push means a run started, ended or was seen.
 */
import {store} from '../../state/app-store';
import {loadScheduleDetail, loadScheduleFacts} from './actions';

/** Start following the route. Answers a teardown. */
export function installScheduleManagerPage(): () => void {
    void loadScheduleFacts();
    return store.subscribe((state, previous, event) => {
        const route = state.mainArea.route;
        if (route.kind !== 'scheduleManager' || route.key === null) return;
        const was = previous.mainArea.route;
        const opened = was.kind !== 'scheduleManager' || was.key !== route.key;
        if (opened || event.type === 'scheduleManagerChanged') void loadScheduleDetail(route.key);
    });
}
