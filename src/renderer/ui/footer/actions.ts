/**
 * What the footer asks of the main process, and the events it dispatches
 * with the answers.
 *
 * The components call these and render whatever the store then says; none of
 * them talks to `window.api` itself. Kept in one module so the footer's whole
 * conversation with main reads in one place.
 */
import {usageGaugeRows} from '../../../domain/usage/usage';
import {dispatch, getState} from '../../state/app-store';
import {installConfirmation} from './footer-view';

/**
 * Fetch the usage windows for the gauges, and for Patch, which reads the same
 * rows: the endpoint rate-limits, so there is one fetch for both.
 *
 * A failure (offline, no credentials) keeps whatever is on screen.
 */
export async function refreshUsage(): Promise<void> {
    try {
        dispatch({type: 'usageFetched', rows: usageGaugeRows(await window.api.getUsage())});
    } catch {
        dispatch({type: 'usageFailed'});
    }
}

/** Ask main for an update it found before this window loaded, and how the install before this launch went. */
export async function checkForUpdate(): Promise<void> {
    const [update, outcome] = await Promise.all([window.api.getUpdate(), window.api.getUpdateOutcome()]);
    dispatch({type: 'updateChecked', update});
    dispatch({type: 'updateOutcomeChecked', outcome});
}

/** Take the footer's running count, after the project list has loaded. */
export function countRunning(): void {
    dispatch({type: 'runningCounted', running: getState().view.activePtyIds.size});
}

/**
 * Download the update, swap it in and restart.
 *
 * Restarting stops every running session, so that is asked first when any
 * are. Each step's progress arrives as `updateProgress` while this waits. On
 * success the app quits from under this; an answer means it did not.
 */
export async function installUpdate(): Promise<void> {
    const {update, view} = getState();
    if (!update.notice?.installable || update.installing) return;

    const question = installConfirmation(view.activePtyIds.size);
    if (question && !confirm(question)) return;

    dispatch({type: 'updateInstallStarted'});
    const result = await window.api.installUpdate();
    if (!result.ok) dispatch({type: 'updateInstallFailed', failure: result.failure});
}

/** Open the release page, for an app that cannot replace itself. */
export function openReleasePage(): void {
    const notice = getState().update.notice;
    if (notice) void window.api.openExternal(notice.pageUrl);
}

/** Hide the "Updated to …" line. */
export function dismissUpdateOutcome(): void {
    dispatch({type: 'updateOutcomeDismissed'});
}

/** Hide the notice until a later version turns up. */
export function dismissUpdate(version: string): void {
    dispatch({type: 'updateDismissed', version});
}
