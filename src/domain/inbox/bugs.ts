/**
 * A Bugsnag project's open errors as the Bug manager's facts (#413).
 *
 * One poll lists the project's open errors three times: over their whole
 * life, and filtered to events in the last 24 hours and the last 7 days.
 * Bugsnag counts a filtered list's `events` in its window, so the two
 * filtered lists give each error its trend's two numbers without asking for
 * its trend one error at a time. An error missing from a filtered list had
 * no events in that window.
 */
import type {BugsnagError} from '../bugsnag/model';
import type {BugFacts} from './model';

/** The facts of each of `projectId`'s open errors, in the order the whole-life list gave them. */
export function bugFacts(
    projectId: string,
    open: readonly BugsnagError[],
    last24h: readonly BugsnagError[],
    last7d: readonly BugsnagError[],
): BugFacts[] {
    const day = eventsById(last24h);
    const week = eventsById(last7d);
    return open.map((error) => ({
        kind: 'bug',
        projectId,
        errorId: error.id,
        errorClass: error.errorClass,
        message: error.message,
        context: error.context,
        severity: error.severity,
        status: error.status,
        releaseStages: error.releaseStages,
        firstSeen: error.firstSeenUnfiltered,
        lastSeen: error.lastSeen,
        events: error.events,
        users: error.users,
        events24h: day.get(error.id) ?? 0,
        // The week holds the day: a 7-day list capped short of an error still counts its day.
        events7d: Math.max(week.get(error.id) ?? 0, day.get(error.id) ?? 0),
        linkedIssues: error.linkedIssues,
    }));
}

function eventsById(errors: readonly BugsnagError[]): Map<string, number> {
    return new Map(errors.map((error) => [error.id, error.events]));
}
