/**
 * Keeping the image cards' defaults (C1, C3) in localStorage: the mode last
 * picked on any card and the background, so both outlive a restart.
 *
 * Read back once when the renderer starts, and written whenever the store's
 * copy changes; the reducer stays free of storage.
 */
import { dispatch, store } from '../../state/app-store';
import { STORAGE_KEYS, readStored, writeStored } from '../../state/storage';
import { storedImageDefaults } from '../../state/session-work-slice';

/** Restore the defaults and start saving them. Answers a teardown. */
export function installImageDefaults(): () => void {
  dispatch({
    type: 'sessionWorkImageDefaultsRestored',
    defaults: storedImageDefaults(
      readStored('localStorage', STORAGE_KEYS.imageCompareMode),
      readStored('localStorage', STORAGE_KEYS.imageCompareBackground),
    ),
  });

  return store.subscribe((state, previous) => {
    const now = state.sessionWork.imageDefaults;
    const was = previous.sessionWork.imageDefaults;
    if (now.mode !== was.mode) writeStored('localStorage', STORAGE_KEYS.imageCompareMode, now.mode);
    if (now.background !== was.background) writeStored('localStorage', STORAGE_KEYS.imageCompareBackground, now.background);
  });
}
