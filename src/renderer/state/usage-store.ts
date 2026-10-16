/**
 * The usage-limit windows, as Patch reads them.
 *
 * The rows live in the store (see `usage-slice`), fetched by the footer (see
 * `ui/footer/actions`); these reads keep Patch's old entry points until it
 * moves to React too.
 */
import { getState, store } from './app-store';
import { tightestIn } from './usage-slice';
import type { UsageLimit } from '../../domain/usage/usage';

/** Resolves once the first fetch has finished. */
export function whenUsageLoaded(): Promise<void> {
  if (getState().usage.loaded) return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = store.subscribe((state) => {
      if (!state.usage.loaded) return;
      unsubscribe();
      resolve();
    });
  });
}

/**
 * The window closest to its limit, or null when nothing is known.
 *
 * The closest one is the one that stops work first, whichever window it is.
 */
export function tightestUsage(): UsageLimit | null {
  return tightestIn(getState().usage);
}
