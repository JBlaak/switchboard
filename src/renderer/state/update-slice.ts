/**
 * The newer release main has found, and what the user has done about it.
 *
 * The dismissal is per version and lives only here, in memory: the × hides
 * this version until the window reloads, and a later version shows again.
 */
import type { RendererEvent } from './events';
import type { UpdateNotice } from '../../domain/update/release';

export interface UpdateState {
  /** The release on offer, or null when there is none. */
  readonly notice: UpdateNotice | null;
  /** The version the user dismissed, if any. */
  readonly dismissed: string | null;
  /** An install is under way; on success the app quits before it ends. */
  readonly installing: boolean;
  /** The last install attempt failed, so the notice offers a retry. */
  readonly failed: boolean;
}

export const initialUpdateState: UpdateState = {
  notice: null, dismissed: null, installing: false, failed: false,
};

export function updateReducer(state: UpdateState, event: RendererEvent): UpdateState {
  switch (event.type) {
    // A fresh notice reads as new: an earlier failure no longer applies to it.
    case 'updateAvailable':
    case 'updateChecked':
      return { ...state, notice: event.update, failed: false };

    case 'updateDismissed':
      return state.dismissed === event.version ? state : { ...state, dismissed: event.version };

    case 'updateInstallStarted':
      return state.installing ? state : { ...state, installing: true };

    case 'updateInstallFailed':
      return { ...state, installing: false, failed: true };

    default:
      return state;
  }
}

/** The notice to show, or null when there is none or it was dismissed. */
export function visibleUpdate(state: UpdateState): UpdateNotice | null {
  const { notice, dismissed } = state;
  return notice && notice.version !== dismissed ? notice : null;
}
