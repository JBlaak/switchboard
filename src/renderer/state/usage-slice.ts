/**
 * The usage-limit windows as the quota gauges last fetched them.
 *
 * Kept in the store rather than inside the gauges so Patch can read the same
 * numbers: the usage endpoint rate-limits, so a second consumer must not mean
 * a second fetch.
 */
import type { RendererEvent } from './events';
import type { UsageLimit } from '../../domain/usage/usage';

export interface UsageState {
  readonly rows: readonly UsageLimit[];
  /** The first fetch has finished, whether or not it got anything. */
  readonly loaded: boolean;
}

export const initialUsageState: UsageState = { rows: [], loaded: false };

export function usageReducer(state: UsageState, event: RendererEvent): UsageState {
  switch (event.type) {
    case 'usageFetched':
      return { rows: event.rows, loaded: true };
    // A failed refresh keeps what an earlier one found.
    case 'usageFailed':
      return state.loaded ? state : { ...state, loaded: true };
    default:
      return state;
  }
}

/**
 * The window closest to its limit, or null when nothing is known.
 *
 * The closest one is the one that stops work first, whichever window it is.
 */
export function tightestIn(state: UsageState): UsageLimit | null {
  let tightest: UsageLimit | null = null;
  for (const row of state.rows) {
    if (!tightest || row.percent > tightest.percent) tightest = row;
  }
  return tightest;
}
