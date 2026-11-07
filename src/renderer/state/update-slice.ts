/**
 * The newer release main has found, and what the user has done about it.
 *
 * The dismissal is per version and lives only here, in memory: the × hides
 * this version until the window reloads, and a later version shows again.
 *
 * While an install runs, `progress` holds the step main last reported, so the
 * footer can say what is happening rather than only that something is. After
 * the restart, `outcome` holds how the install went until the user hides it.
 */
import type {RendererEvent} from './events';
import type {UpdateNotice} from '../../domain/update/release';
import type {InstallFailure, InstallProgress, UpdateOutcome} from '../../domain/update/progress';

export interface UpdateState {
    /** The release on offer, or null when there is none. */
    readonly notice: UpdateNotice | null;
    /** The version the user dismissed, if any. */
    readonly dismissed: string | null;
    /** An install is under way; on success the app quits before it ends. */
    readonly installing: boolean;
    /** The step the running install last reported; null before the first, or with none running. */
    readonly progress: InstallProgress | null;
    /** Where the last install attempt stopped, so the notice can say so and offer a retry. */
    readonly failure: InstallFailure | null;
    /** How the install before this launch went, until dismissed. */
    readonly outcome: UpdateOutcome | null;
}

export const initialUpdateState: UpdateState = {
    notice: null,
    dismissed: null,
    installing: false,
    progress: null,
    failure: null,
    outcome: null,
};

export function updateReducer(state: UpdateState, event: RendererEvent): UpdateState {
    switch (event.type) {
        // A fresh notice reads as new: an earlier failure no longer applies to it.
        case 'updateAvailable':
        case 'updateChecked':
            return {...state, notice: event.update, failure: null};

        case 'updateDismissed':
            return state.dismissed === event.version ? state : {...state, dismissed: event.version};

        case 'updateInstallStarted':
            return state.installing ? state : {...state, installing: true, progress: null, failure: null};

        // Progress that arrives after the install answered belongs to no install on screen.
        case 'updateProgress':
            return state.installing ? {...state, progress: event.progress} : state;

        case 'updateInstallFailed':
            return {...state, installing: false, progress: null, failure: event.failure};

        case 'updateOutcomeChecked':
            return {...state, outcome: event.outcome};

        case 'updateOutcomeDismissed':
            return state.outcome ? {...state, outcome: null} : state;

        default:
            return state;
    }
}

/** The notice to show, or null when there is none or it was dismissed. */
export function visibleUpdate(state: UpdateState): UpdateNotice | null {
    const {notice, dismissed, installing} = state;
    // An install under way stays on screen: there is no hiding what is about to restart the app.
    if (installing) return notice;
    return notice && notice.version !== dismissed ? notice : null;
}
