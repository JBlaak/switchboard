/**
 * Snoozing an inbox item (#412): where a bug or an issue can be put away to,
 * as a pure function of now and, when the Planner gave one, the cycle today
 * falls in.
 *
 * Every dated option wakes at 09:00 local time:
 *
 * - Tomorrow.
 * - Later this week: today + 2 days, offered Monday to Wednesday only, so it
 *   lands on Wednesday, Thursday or Friday.
 * - 1 week: the same weekday next week.
 * - Until it changes: no date; the item wakes when it changes.
 *
 * With a cycle, three more, each on a Monday:
 *
 * - Last week of this cycle: the Monday of its last week.
 * - Upcoming cooldown week: the Monday of the cooldown after this cycle.
 * - Next cycle: the Monday the next cycle's build starts, the day after that
 *   cooldown ends.
 *
 * Only cycle days after today are offered, so the last week drops out once
 * it has begun. Without a cycle (no Planner URL, or no answer) they are not
 * offered at all.
 */
import {addDays, dayOf} from './cycle';
import type {Cycle} from './cycle';

export type InboxSnoozeKind =
    'tomorrow' | 'laterThisWeek' | 'oneWeek' | 'untilChanged' | 'lastWeekOfCycle' | 'cooldown' | 'nextCycle';

export interface InboxSnoozeOption {
    readonly kind: InboxSnoozeKind;
    readonly label: string;
    /** When the item wakes; null for Until it changes. */
    readonly until: Date | null;
    /** The cycle options come from the Planner; a menu sets them apart. */
    readonly cycle: boolean;
}

/** The hour every dated snooze wakes at, local time. */
export const SNOOZE_WAKE_HOUR = 9;

const MONDAY = 1,
    WEDNESDAY = 3;

/** `now`'s day, `days` on, at the wake hour. */
function wakeOn(now: Date, days: number): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, SNOOZE_WAKE_HOUR);
}

/** `day` (YYYY-MM-DD) at the wake hour. */
function wakeOnDay(day: string): Date {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y!, m! - 1, d!, SNOOZE_WAKE_HOUR);
}

/** The snooze options open at `now`, in menu order: the fixed ones, then the cycle ones. */
export function inboxSnoozeOptions(now: Date, cycle: Cycle | null): InboxSnoozeOption[] {
    const weekday = now.getDay();
    const options: InboxSnoozeOption[] = [{kind: 'tomorrow', label: 'Tomorrow', until: wakeOn(now, 1), cycle: false}];
    if (weekday >= MONDAY && weekday <= WEDNESDAY) {
        options.push({kind: 'laterThisWeek', label: 'Later this week', until: wakeOn(now, 2), cycle: false});
    }
    options.push(
        {kind: 'oneWeek', label: '1 week', until: wakeOn(now, 7), cycle: false},
        {kind: 'untilChanged', label: 'Until it changes', until: null, cycle: false},
    );
    if (cycle) options.push(...cycleSnoozes(cycle, dayOf(now)));
    return options;
}

/** The cycle options still ahead of `today`. */
function cycleSnoozes(cycle: Cycle, today: string): InboxSnoozeOption[] {
    const candidates: {kind: InboxSnoozeKind; label: string; day: string}[] = [
        {kind: 'lastWeekOfCycle', label: 'Last week of this cycle', day: cycle.weeks[cycle.weeks.length - 1]!},
        {kind: 'cooldown', label: 'Upcoming cooldown week', day: cycle.cooldownAfter.from},
        {kind: 'nextCycle', label: 'Next cycle', day: addDays(cycle.cooldownAfter.till, 1)},
    ];
    return candidates
        .filter((candidate) => candidate.day > today)
        .map(({kind, label, day}) => ({kind, label, until: wakeOnDay(day), cycle: true}));
}
