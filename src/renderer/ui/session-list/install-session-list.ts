/**
 * The session list's work outside React: the 30-second clock and keeping the
 * open slug groups in sessionStorage.
 *
 * Here rather than in a component for the same reason as the footer's timers:
 * what they produce is state, and a component's effects run twice under
 * StrictMode.
 */
import { dispatch, store } from '../../state/app-store';
import { STORAGE_KEYS, readStored, writeStored } from '../../state/storage';

/** Fine enough that "just now" becomes "1m ago" without a visible lag. */
const TICK_MS = 30000;

/** Restore the open groups and start the clock. Answers a teardown. */
export function installSessionList(): () => void {
  dispatch({ type: 'slugGroupsRestored', ids: storedExpandedSlugs() });

  // A reload should not fold every group the user had open.
  const unsubscribe = store.subscribe((state, previous) => {
    const { expandedSlugs } = state.sessionList;
    if (expandedSlugs === previous.sessionList.expandedSlugs) return;
    writeStored('sessionStorage', STORAGE_KEYS.expandedSlugs, JSON.stringify(Object.keys(expandedSlugs)));
  });

  const tick = setInterval(() => dispatch({ type: 'sessionListTicked', now: Date.now() }), TICK_MS);

  return () => {
    unsubscribe();
    clearInterval(tick);
  };
}

function storedExpandedSlugs(): string[] {
  try {
    const ids = JSON.parse(readStored('sessionStorage', STORAGE_KEYS.expandedSlugs) || '[]') as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
