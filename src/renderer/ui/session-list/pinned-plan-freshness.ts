/**
 * Whether a pinned plan row's progress is out of date, worked out without
 * React so it can be tested. A row has no room for a freshness line, so an
 * out-of-date row dims its progress and says why in a tooltip, in the shared
 * freshness words ("Updated 14m ago · Couldn't refresh").
 *
 * A row is out of date when its last live read is more than two polls old,
 * when that read failed, or while GitHub's budget is held. Before the first
 * live read answers (the stored copy is showing, or nothing is) it is
 * refreshing, and refreshing is not out of date: the row looks as a fresh one.
 */
import {freshnessText} from '../shared/freshness-text';
import type {PlanProgressRead} from '../../state/plan-slice';

/** How often the followed plans are asked for again: a sidebar glance, not the plan view's minute. */
export const PINNED_PLAN_POLL_MS = 5 * 60_000;

/** A read older than this missed two polls, so the row says it is out of date. */
export const PINNED_PLAN_STALE_MS = 2 * PINNED_PLAN_POLL_MS;

/**
 * The tooltip for a row whose progress is out of date at `now`, with GitHub's
 * budget held until `heldUntil` (null when it is not); null when it is fresh
 * or still on its first read.
 */
export function pinnedPlanStaleText(
    read: PlanProgressRead | undefined,
    now: number,
    heldUntil: number | null,
): string | null {
    const fetchedAt = read?.fetchedAt ?? null;
    const failed = read?.failed ?? false;
    const held = heldUntil !== null && heldUntil > now;
    const old = fetchedAt !== null && now - fetchedAt > PINNED_PLAN_STALE_MS;
    if (!held && !failed && !old) return null;
    return freshnessText({fetchedAt, failed}, now, heldUntil);
}
