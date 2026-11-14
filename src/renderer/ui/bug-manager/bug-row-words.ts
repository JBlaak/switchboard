/**
 * What a Bug manager row and its detail say in words and numbers: how long
 * ago something was, counts made short, how far today is above the bug's
 * daily average, and what a quick triage (T) found and suggests. Pure, so
 * the page only lays them out.
 */
import type {BugFacts, BugTriage, TriageSuggestion} from '../../../domain/inbox/model';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago `at` (ISO or epoch ms) was, as a row says it: "just now",
 * "2 min ago", "3 h ago", "yesterday", "6 days ago", "3 months ago",
 * "2 years ago". A time in the future is "just now"; one that does not
 * parse is empty.
 */
export function relativeAge(at: string | number, now: number = Date.now()): string {
    const then = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(then)) return '';
    const ago = Math.max(0, now - then);
    if (ago < MINUTE) return 'just now';
    if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
    if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
    if (ago < 2 * DAY) return 'yesterday';
    const days = Math.floor(ago / DAY);
    if (days < 30) return `${days} days ago`;
    if (days < 365) {
        const months = Math.floor(days / 30);
        return months === 1 ? 'a month ago' : `${months} months ago`;
    }
    const years = Math.floor(days / 365);
    return years === 1 ? 'a year ago' : `${years} years ago`;
}

const grouped = new Intl.NumberFormat('en-US');

/** A count with thousands separators: 1,234. */
export function groupedCount(n: number): string {
    return grouped.format(Math.round(n));
}

/** A count made short: 950, 1.2k, 73k, 1.4M. */
export function compactCount(n: number): string {
    const value = Math.round(n);
    if (value < 1000) return String(value);
    if (value < 10_000) return `${trimmed(value / 1000)}k`;
    if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
    if (value < 10_000_000) return `${trimmed(value / 1_000_000)}M`;
    return `${Math.round(value / 1_000_000)}M`;
}

/** One decimal, dropped when it is a zero: 1.2, 3. */
function trimmed(n: number): string {
    const one = (Math.floor(n * 10) / 10).toFixed(1);
    return one.endsWith('.0') ? one.slice(0, -2) : one;
}

/**
 * How many times its daily average (the last 7 days over 7) the last 24
 * hours were, when that is worth a row's mention: an average to compare
 * with and at least 1.5 times it. Null otherwise.
 */
export function timesItsAverage(facts: Pick<BugFacts, 'events24h' | 'events7d'>): number | null {
    const average = facts.events7d / 7;
    if (!(average > 0)) return null;
    const times = facts.events24h / average;
    return times >= 1.5 ? times : null;
}

/** Where a bug's triage is: none yet, its errand running, stopped without a verdict, or its verdict in. */
export type TriagePhase = 'none' | 'running' | 'stopped' | 'verdict';

export function triagePhase(triage: BugTriage | null | undefined): TriagePhase {
    if (!triage) return 'none';
    if (triage.verdict) return 'verdict';
    return triage.stoppedAt === null ? 'running' : 'stopped';
}

/** A suggestion as the row and the detail say it. */
export const TRIAGE_SUGGESTION_LABEL: Record<TriageSuggestion, string> = {
    fix: 'Fix',
    snooze: 'safe to snooze',
    backlog: 'backlog',
    needsYou: 'needs you',
};

/** The sorting buttons a bug can have; the primary one is the triage's suggestion. */
export type BugSortAction = 'fix' | 'snooze' | 'backlog';

/**
 * Which button is primary: the one a triage's verdict suggests, Fix when it
 * suggests nothing a button does (needs you) or there is no verdict, and Fix
 * too when the suggested button is not there (a snoozed bug has no Snooze).
 */
export function primarySortAction(
    triage: BugTriage | null | undefined,
    shown: ReadonlySet<BugSortAction>,
): BugSortAction {
    const suggestion = triage?.verdict?.suggestion;
    if ((suggestion === 'snooze' || suggestion === 'backlog') && shown.has(suggestion)) return suggestion;
    return 'fix';
}
