/**
 * The usage-limit windows, as the vanilla code records and reads them.
 *
 * The rows live in the store (see `usage-slice`); these calls dispatch and
 * read so the gauges and Patch keep their old entry points.
 */
import { dispatch, getState, store } from './app-store';
import { tightestIn } from './usage-slice';
import type { UsageLimit } from '../../domain/usage/usage';

export function recordUsage(next: readonly UsageLimit[]): void {
  dispatch({ type: 'usageFetched', rows: next });
}

/** The first fetch has finished, whether or not it got anything. */
export function usageSettled(): void {
  dispatch({ type: 'usageFailed' });
}

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
