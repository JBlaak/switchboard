/**
 * When this window first saw a head in a step GitHub gives no start time for
 * (being updated, merging, checks not yet started): what its bar times the
 * step from. Kept for the window's life; a restart starts the clock again.
 */
const seen = new Map<string, number>();

/** The most kept: the oldest go first. */
const MOST = 200;

/** When `key` (a PR and its step) was first asked about; `now` the first time. */
export function firstSeen(key: string, now: number = Date.now()): number {
    const at = seen.get(key);
    if (at !== undefined) return at;
    seen.set(key, now);
    if (seen.size > MOST) seen.delete(seen.keys().next().value!);
    return now;
}
