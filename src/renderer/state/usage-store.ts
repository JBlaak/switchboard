/**
 * The usage-limit windows as the quota gauges last fetched them.
 *
 * Kept here rather than inside the gauges so Patch can read the same numbers:
 * the usage endpoint rate-limits, so a second consumer must not mean a second
 * fetch.
 */
import type { UsageLimit } from '../../domain/usage/usage';

let rows: readonly UsageLimit[] = [];
let markLoaded: () => void = () => {};
const loaded = new Promise<void>(resolve => { markLoaded = resolve; });

export function recordUsage(next: readonly UsageLimit[]): void {
  rows = next;
  markLoaded();
}

/** The first fetch has finished, whether or not it got anything. */
export function usageSettled(): void {
  markLoaded();
}

/** Resolves once the first fetch has finished. */
export function whenUsageLoaded(): Promise<void> {
  return loaded;
}

/**
 * The window closest to its limit, or null when nothing is known.
 *
 * The closest one is the one that stops work first, whichever window it is.
 */
export function tightestUsage(): UsageLimit | null {
  let tightest: UsageLimit | null = null;
  for (const row of rows) {
    if (!tightest || row.percent > tightest.percent) tightest = row;
  }
  return tightest;
}
