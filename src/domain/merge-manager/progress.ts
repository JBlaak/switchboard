/**
 * The Merge manager's progress bars between two reads: a step's bar fills on
 * its own toward the time the step is expected to take, so it moves while
 * GitHub says nothing new, and never falls behind what the last read said
 * (its checks passed so far). It stops short of full (`FILL_CAP`): only the
 * step being done fills it. Once the step runs past its expected time, the
 * bar no longer pretends to know and slides instead.
 *
 * Pure; times are epoch ms.
 */

/** How far a bar fills on time alone: the last bit is the step being done. */
export const FILL_CAP = 0.95;

/** What a bar knows of its step. */
export interface BarTiming {
    /** What the last read said, 0–1 (checks passed of all); null when it says nothing. */
    readonly actual: number | null;
    /** When the step started; null when unknown. */
    readonly startedAt: number | null;
    /** How long the step is expected to take; null when there is nothing to go by. */
    readonly expectedMs: number | null;
}

export type BarProgress =
    /** A bar that stays where it is: a step done (1), one to come (0), or the last read's fraction. */
    | {readonly kind: 'fixed'; readonly value: number}
    /** A bar filling from `from` now to `FILL_CAP` in `remainingMs`, at an even pace. */
    | {readonly kind: 'filling'; readonly from: number; readonly to: number; readonly remainingMs: number}
    /** A step past its expected time, or with nothing to time it by: a sliding segment. */
    | {readonly kind: 'indeterminate'};

/** Where a bar is at `now`: filling toward its expected time, or sliding once past it. */
export function barProgress(timing: BarTiming | number, now: number): BarProgress {
    if (typeof timing === 'number') return {kind: 'fixed', value: clamp(timing)};
    const {actual, startedAt, expectedMs} = timing;
    if (startedAt === null || expectedMs === null || expectedMs <= 0) {
        return actual !== null ? {kind: 'fixed', value: clamp(actual)} : {kind: 'indeterminate'};
    }
    const elapsed = Math.max(0, now - startedAt);
    if (elapsed >= expectedMs) return {kind: 'indeterminate'};
    const onTime = FILL_CAP * (elapsed / expectedMs);
    const from = Math.max(onTime, Math.min(FILL_CAP, clamp(actual ?? 0)));
    return {kind: 'filling', from, to: FILL_CAP, remainingMs: expectedMs - elapsed};
}

function clamp(value: number): number {
    return Math.min(1, Math.max(0, value));
}
