/**
 * When a schedule's cron comes round next, and what it says in plain English.
 *
 * The scheduler itself never computes a next time: it ticks once a minute and
 * asks `cronMatches` whether now is the time. The Schedule manager's page has
 * to say "next at 03:00" and sort by it, so the fields are read here the way
 * `cron.ts` reads them — the same grammar (`*`, `*` with a `/n` step, lists,
 * ranges), the same quirks (a step counts from zero, the day of the month and
 * the weekday must both match, 7 is not Sunday) — so the time promised is the
 * minute the tick will start it.
 */

/** One field's bounds, inclusive. */
interface FieldRange {
    readonly min: number;
    readonly max: number;
}

const MINUTE: FieldRange = {min: 0, max: 59};
const HOUR: FieldRange = {min: 0, max: 23};
const DAY: FieldRange = {min: 1, max: 31};
const MONTH: FieldRange = {min: 1, max: 12};
const WEEKDAY: FieldRange = {min: 0, max: 6};

/** How far ahead to look: past four years, so a cron for 29 February still finds its day. */
const SEARCH_DAYS = 366 * 4 + 31;

/** A cron read into the values each field accepts. */
interface CronSets {
    readonly minutes: readonly number[];
    readonly hours: readonly number[];
    readonly days: ReadonlySet<number>;
    readonly months: ReadonlySet<number>;
    readonly weekdays: ReadonlySet<number>;
}

/** Exactly `cron.ts`'s field test, so both agree on every value. */
function fieldMatches(field: string, value: number): boolean {
    if (field === '*') return true;
    if (field.startsWith('*/')) {
        const step = parseInt(field.slice(2), 10);
        return Number.isFinite(step) && step > 0 && value % step === 0;
    }
    if (field.includes(',')) {
        return field.split(',').some((f) => fieldMatches(f.trim(), value));
    }
    if (field.includes('-')) {
        const [lo, hi] = field.split('-').map(Number);
        return value >= lo && value <= hi;
    }
    return parseInt(field, 10) === value;
}

function valuesOf(field: string, range: FieldRange): number[] {
    const values: number[] = [];
    for (let v = range.min; v <= range.max; v++) if (fieldMatches(field, v)) values.push(v);
    return values;
}

/** A single value, a range or a step, written the way `cron.ts` reads it. */
const TERM = /^(\*|\*\/\d+|\d+|\d+-\d+)$/;

function termIsValid(term: string, range: FieldRange): boolean {
    if (!TERM.test(term)) return false;
    if (term === '*') return true;
    if (term.startsWith('*/')) return Number(term.slice(2)) > 0;
    const [lo, hi] = term.split('-').map(Number);
    const top = hi ?? lo;
    return lo >= range.min && top <= range.max && lo <= top;
}

function fieldIsValid(field: string, range: FieldRange): boolean {
    return field.split(',').every((term) => termIsValid(term, range));
}

function readCron(cron: string): CronSets | null {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minute, hour, day, month, weekday] = parts;
    return {
        minutes: valuesOf(minute, MINUTE),
        hours: valuesOf(hour, HOUR),
        days: new Set(valuesOf(day, DAY)),
        months: new Set(valuesOf(month, MONTH)),
        weekdays: new Set(valuesOf(weekday, WEEKDAY)),
    };
}

/**
 * Whether a cron is five fields the matcher reads as written and that come
 * round at least once. Stricter than `cronMatches`, which would quietly never
 * match a typo: a schedule saved from the page has to be one that runs.
 */
export function isValidCron(cron: string): boolean {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const ranges = [MINUTE, HOUR, DAY, MONTH, WEEKDAY];
    if (!parts.every((field, i) => fieldIsValid(field, ranges[i]))) return false;
    return nextRunAfter(cron, Date.UTC(2024, 0, 1)) !== null;
}

/**
 * The first minute strictly after `after` (epoch ms) that the cron matches,
 * in local time, as epoch ms; null when it never does (a malformed cron, or
 * 31 February).
 *
 * Walks days, and within a matching day only the hours and minutes the cron
 * names, so a yearly cron costs a few hundred day checks rather than half a
 * million minutes. A minute the clocks skip (02:30 on the night summer time
 * starts) is passed over, as the tick passes over it.
 */
export function nextRunAfter(cron: string, after: number): number | null {
    const sets = readCron(cron);
    if (!sets || sets.minutes.length === 0 || sets.hours.length === 0) return null;

    const start = new Date(after);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());

    for (let i = 0; i < SEARCH_DAYS; i++) {
        if (sets.months.has(day.getMonth() + 1) && sets.days.has(day.getDate()) && sets.weekdays.has(day.getDay())) {
            const found = firstTimeOn(day, sets, start.getTime());
            if (found !== null) return found;
        }
        day.setDate(day.getDate() + 1);
    }
    return null;
}

function firstTimeOn(day: Date, sets: CronSets, notBefore: number): number | null {
    for (const hour of sets.hours) {
        for (const minute of sets.minutes) {
            const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
            if (at.getTime() < notBefore) continue;
            // Asked for a minute the clocks skipped: Date moved it, the tick never sees it.
            if (at.getHours() !== hour || at.getMinutes() !== minute || at.getDate() !== day.getDate()) continue;
            return at.getTime();
        }
    }
    return null;
}

/**
 * The earliest time of day, in minutes after midnight, that the cron runs
 * between `from` and `to` (both minutes after midnight, inclusive), on any
 * day; null when it never runs in that window. For the wake: a nightly job
 * needs the Mac awake for its earliest time.
 */
export function earliestTimeOfDay(cron: string, from: number, to: number): number | null {
    const sets = readCron(cron);
    if (!sets || sets.days.size === 0 || sets.months.size === 0 || sets.weekdays.size === 0) return null;
    for (const hour of sets.hours) {
        for (const minute of sets.minutes) {
            const at = hour * 60 + minute;
            if (at >= from && at <= to) return at;
        }
    }
    return null;
}

/** `HH:MM` for minutes after midnight, wrapping round the day. */
export function clockTime(minutes: number): string {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

// ── In plain English ──

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Before this hour a daily time reads as "every night". */
const NIGHT_ENDS = 7;

function single(field: string, range: FieldRange): number | null {
    if (!/^\d+$/.test(field)) return null;
    const value = Number(field);
    return value >= range.min && value <= range.max ? value : null;
}

function joinNames(names: readonly string[]): string {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The days part of a daily-or-weekly cron: "Every night", "Weekdays", "Every Monday"; null when it is not one of those. */
function daysPhrase(weekday: string, hour: number): string | null {
    if (weekday === '*') return hour < NIGHT_ENDS ? 'Every night' : 'Every day';
    const days = valuesOf(weekday, WEEKDAY);
    if (!fieldIsValid(weekday, WEEKDAY) || days.length === 0) return null;
    if (days.join() === '1,2,3,4,5') return 'Weekdays';
    if (days.join() === '0,6') return 'Weekends';
    if (days.length === 7) return hour < NIGHT_ENDS ? 'Every night' : 'Every day';
    return `Every ${joinNames(days.map((d) => DAY_NAMES[d]))}`;
}

/**
 * The cron as the page says it: "Every night at 03:00", "Weekdays at 06:30",
 * "Every Monday at 09:00", "Every hour at :15", "Every 15 minutes"; the cron
 * itself when it is anything more particular than that.
 */
export function describeCron(cron: string): string {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5 || !isValidCron(cron)) return cron.trim();
    const [minuteField, hourField, day, month, weekday] = parts;
    if (day !== '*' || month !== '*') return cron.trim();

    const minute = single(minuteField, MINUTE);
    const hour = single(hourField, HOUR);

    if (minute !== null && hour !== null) {
        const days = daysPhrase(weekday, hour);
        return days ? `${days} at ${clockTime(hour * 60 + minute)}` : cron.trim();
    }
    if (weekday !== '*') return cron.trim();
    if (minute !== null && hourField === '*') return `Every hour at :${String(minute).padStart(2, '0')}`;
    const minuteStep = /^\*\/(\d+)$/.exec(minuteField);
    if (minuteStep && hourField === '*') {
        return Number(minuteStep[1]) === 1 ? 'Every minute' : `Every ${minuteStep[1]} minutes`;
    }
    const hourStep = /^\*\/(\d+)$/.exec(hourField);
    if (hourStep && minute !== null) {
        const at = `:${String(minute).padStart(2, '0')}`;
        return Number(hourStep[1]) === 1 ? `Every hour at ${at}` : `Every ${hourStep[1]} hours at ${at}`;
    }
    return cron.trim();
}
