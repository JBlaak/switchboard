/**
 * A bug's signals (#413, #409 story 7), from what a poll read of it.
 *
 * - **New**: open, in production, of severity error, and first seen at or
 *   after Switchboard first synced its Bugsnag project. The backlog a first
 *   sync brings in is unread too, but it is not new.
 * - **Trending**: its last 24 hours hold at least `multiplier` times its
 *   7-day daily average (the 7 days' events over 7, today's included), and at
 *   least `minEvents` events.
 * - **Regressed**: not judged here. The Bug manager page decides it from the
 *   events after a merge (#414) and sets it on the item; a poll keeps it.
 */
import type {TrendingThresholds} from '../bugsnag/connection';
import type {BugFacts, BugSignals} from './model';

/** The release stage a new bug must be seen in. */
export const NEW_RELEASE_STAGE = 'production';
/** The severity a new bug must have. */
export const NEW_SEVERITY = 'error';

/** Whether a bug's last 24 hours stand out against its last 7 days. */
export function isTrending(
    counts: {readonly events24h: number; readonly events7d: number},
    thresholds: TrendingThresholds,
): boolean {
    if (counts.events24h < thresholds.minEvents) return false;
    const dailyAverage = counts.events7d / 7;
    return counts.events24h >= thresholds.multiplier * dailyAverage;
}

/**
 * Whether a bug is new: open, in production (or in no release stage at all,
 * for an app that reports none), of severity error, and first seen at or
 * after `watchingSince`, when its project was first synced.
 */
export function isNew(facts: BugFacts, watchingSince: number): boolean {
    const firstSeen = Date.parse(facts.firstSeen);
    return (
        facts.status === 'open' &&
        facts.severity === NEW_SEVERITY &&
        (facts.releaseStages.length === 0 || facts.releaseStages.includes(NEW_RELEASE_STAGE)) &&
        Number.isFinite(firstSeen) &&
        firstSeen >= watchingSince
    );
}

/** A bug's signals from its facts; `regressed` carries over from what it had. */
export function bugSignals(
    facts: BugFacts,
    context: {readonly watchingSince: number; readonly thresholds: TrendingThresholds; readonly regressed: boolean},
): BugSignals {
    return {
        new: isNew(facts, context.watchingSince),
        trending: isTrending(facts, context.thresholds),
        regressed: context.regressed,
    };
}
