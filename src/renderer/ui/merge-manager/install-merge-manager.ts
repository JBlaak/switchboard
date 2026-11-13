/**
 * The Merge manager's launch-time work (#434): read its lanes, which main
 * has had since before the window opened; every change after is pushed
 * (`mergeManagerChanged`).
 */
import {dispatch} from '../../state/app-store';

export function installMergeManager(): void {
    void window.api
        .mergeManagerState()
        .then((state) => dispatch({type: 'mergeManagerChanged', state}))
        .catch(() => {
            // Main answers on its next change.
        });
}
