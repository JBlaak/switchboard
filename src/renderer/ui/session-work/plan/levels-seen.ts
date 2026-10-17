/**
 * Keeping the level last seen per plan (A4) in localStorage, so a level that
 * cleared while Switchboard was closed still celebrates when the plan shows
 * next, and a plan seen before is not a first sighting after a restart.
 *
 * Read back once when the renderer starts, and written whenever the store's
 * copy changes; the reducer stays free of storage.
 */
import { dispatch, store } from '../../../state/app-store';
import { STORAGE_KEYS, readStored, writeStored } from '../../../state/storage';
import { storedLevelsSeen } from '../../../state/plan-slice';

/** Restore the levels seen and start saving them. Answers a teardown. */
export function installLevelsSeen(): () => void {
  dispatch({ type: 'planLevelsSeenRestored', seen: { ...storedLevelsSeen(readStored('localStorage', STORAGE_KEYS.planLevelsSeen)) } });

  return store.subscribe((state, previous) => {
    if (state.plan.levelsSeen !== previous.plan.levelsSeen) {
      writeStored('localStorage', STORAGE_KEYS.planLevelsSeen, JSON.stringify(state.plan.levelsSeen));
    }
  });
}
