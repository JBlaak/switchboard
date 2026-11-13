/**
 * A cycle (#412): MoveLab plans in seven-week cycles, each a cooldown week
 * followed by six build weeks. The Planner owns the dates; Switchboard reads
 * them to offer cycle-shaped snoozes in the managers' inboxes.
 *
 * The Planner answers `GET /api/cycle/details` (optionally `?cycle=n`) with
 * the shape `PlannerCycle` names. `toCycle` keeps only what the snoozes need
 * and refuses an answer without those dates, so a half answer hides the
 * cycle snoozes rather than offering a wrong day. Mirrors BlaakTasks' own
 * `PlannerCycleProvider`.
 *
 * Days are `YYYY-MM-DD`, compared as text.
 */

/** A run of days, both ends included. */
export interface Period {
    readonly from: string;
    readonly till: string;
}

export interface Cycle {
    readonly number: number;
    readonly from: string;
    readonly till: string;
    /** The Monday of each of its weeks, first to last. */
    readonly weeks: readonly string[];
    /** The six weeks after its own cooldown. */
    readonly build: Period;
    /** The next cycle's first week: the cooldown that follows this cycle's build. */
    readonly cooldownAfter: Period;
}

/** What the Planner answers, as far as Switchboard reads it. */
export interface PlannerCycle {
    number: number;
    from: string;
    till: string;
    weeks: string[];
    build: Period;
    cooldown_after: Period & {cycle?: number};
    previous_cycle: number | null;
    next_cycle: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (day: unknown): day is string => typeof day === 'string' && DAY.test(day);
const isPeriod = (period: any): boolean => isDay(period?.from) && isDay(period?.till);

/** The Planner's answer as a Cycle; null for an answer without the dates the snoozes need. */
export function toCycle(answer: unknown): Cycle | null {
    const c = answer as Partial<PlannerCycle> | null | undefined;
    if (
        !c ||
        typeof c.number !== 'number' ||
        !isDay(c.from) ||
        !isDay(c.till) ||
        !Array.isArray(c.weeks) ||
        c.weeks.length === 0 ||
        !c.weeks.every(isDay) ||
        !isPeriod(c.build) ||
        !isPeriod(c.cooldown_after)
    ) {
        return null;
    }
    return {
        number: c.number,
        from: c.from,
        till: c.till,
        weeks: [...c.weeks],
        build: {from: c.build!.from, till: c.build!.till},
        cooldownAfter: {from: c.cooldown_after!.from, till: c.cooldown_after!.till},
    };
}

/** Which neighbour to ask for when `day` falls outside the cycle the Planner answered; null when it is inside. */
export function neighbourFor(answer: PlannerCycle, day: string): number | null {
    if (day < answer.from) return answer.previous_cycle ?? null;
    if (day > answer.till) return typeof answer.next_cycle === 'number' ? answer.next_cycle : null;
    return null;
}

/** `date`'s local calendar day. */
export function dayOf(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day `days` after `day`. */
export function addDays(day: string, days: number): string {
    const [y, m, d] = day.split('-').map(Number);
    return dayOf(new Date(y!, m! - 1, d! + days));
}
