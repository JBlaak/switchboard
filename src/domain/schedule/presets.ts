/**
 * A schedule's When, as the form shows it: a preset (Nightly, Weekdays,
 * Weekly, Hourly) and a time, or a raw cron expression for anything else.
 *
 * The schedule file only keeps the cron, so the preset is read back from it
 * each time: a cron that matches no preset's shape is shown as Cron…, never
 * rewritten into one.
 */

export type SchedulePreset = 'nightly' | 'weekdays' | 'weekly' | 'hourly' | 'cron';

/** The presets in the order the form offers them. */
export const SCHEDULE_PRESETS: readonly {readonly value: SchedulePreset; readonly label: string}[] = [
    {value: 'nightly', label: 'Nightly'},
    {value: 'weekdays', label: 'Weekdays'},
    {value: 'weekly', label: 'Weekly'},
    {value: 'hourly', label: 'Hourly'},
    {value: 'cron', label: 'Cron…'},
];

/** Cron's day numbers, Sunday first. */
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A When, every part filled in whether its preset uses it or not, so
 * switching presets keeps the time the user already picked.
 */
export interface ScheduleWhen {
    readonly preset: SchedulePreset;
    /** 0–23; unused by Hourly. */
    readonly hour: number;
    /** 0–59. */
    readonly minute: number;
    /** 0 (Sunday) – 6; Weekly only. */
    readonly day: number;
    /** The expression itself: what Cron… edits, and what any other preset comes to. */
    readonly cron: string;
}

/** What a part a cron does not say defaults to: 03:00 on a Monday. */
const DEFAULT_HOUR = 3;
const DEFAULT_MINUTE = 0;
const DEFAULT_DAY = 1;

/** The When a cron expression reads as: its preset when it has one's shape, Cron… otherwise. */
export function whenFromCron(cron: string): ScheduleWhen {
    const text = cron.trim().replace(/\s+/g, ' ');
    const fallback: ScheduleWhen = {
        preset: 'cron',
        hour: DEFAULT_HOUR,
        minute: DEFAULT_MINUTE,
        day: DEFAULT_DAY,
        cron: text,
    };
    const parts = text.split(' ');
    if (parts.length !== 5) return fallback;
    const [m, h, dom, month, dow] = parts;
    const minute = plain(m, 59);
    if (minute === null || dom !== '*' || month !== '*') return fallback;

    if (h === '*') {
        return dow === '*' ? {...fallback, preset: 'hourly', minute} : {...fallback, minute};
    }
    const hour = plain(h, 23);
    if (hour === null) return {...fallback, minute};
    const at = {...fallback, hour, minute};
    if (dow === '*') return {...at, preset: 'nightly'};
    if (dow === '1-5') return {...at, preset: 'weekdays'};
    const day = plain(dow, 6);
    return day === null ? at : {...at, preset: 'weekly', day};
}

/** The cron a When comes to. Cron… is its own expression, as typed. */
export function cronFromWhen(when: ScheduleWhen): string {
    const {minute, hour, day} = when;
    switch (when.preset) {
        case 'nightly':
            return `${minute} ${hour} * * *`;
        case 'weekdays':
            return `${minute} ${hour} * * 1-5`;
        case 'weekly':
            return `${minute} ${hour} * * ${day}`;
        case 'hourly':
            return `${minute} * * * *`;
        case 'cron':
            return when.cron;
    }
}

/**
 * Switch to another preset, keeping the time. Into Cron… the expression
 * starts as what the old preset came to, so it can be edited from there.
 */
export function withPreset(when: ScheduleWhen, preset: SchedulePreset): ScheduleWhen {
    if (preset === when.preset) return when;
    const next = {...when, preset, cron: cronFromWhen(when)};
    return preset === 'cron' ? next : {...next, cron: cronFromWhen(next)};
}

/** The same When at another time of day (`HH:MM`); unchanged when the text is not a time. */
export function withTime(when: ScheduleWhen, time: string): ScheduleWhen {
    const at = parseTime(time);
    if (!at) return when;
    const next = {...when, ...at};
    return {...next, cron: cronFromWhen(next)};
}

/** `HH:MM`, zero-padded. */
export function formatTime(hour: number, minute: number): string {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** `H:MM` or `HH:MM` as hour and minute; null for anything else. */
export function parseTime(text: string): {hour: number; minute: number} | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? {hour, minute} : null;
}

/** The fields of a cron expression, with the values each may take. */
const FIELDS: readonly {readonly name: string; readonly min: number; readonly max: number}[] = [
    {name: 'Minute', min: 0, max: 59},
    {name: 'Hour', min: 0, max: 23},
    {name: 'Day of the month', min: 1, max: 31},
    {name: 'Month', min: 1, max: 12},
    {name: 'Weekday', min: 0, max: 6},
];

/**
 * What is wrong with a cron expression, in a few words; null when the
 * scheduler can run it.
 *
 * Only what the scheduler's matcher (`cron.ts`) understands passes: `*`,
 * `*` with a step, numbers, ranges and lists of those. Names (MON, JAN) and
 * stepped ranges do not, since they would never match.
 */
export function cronProblem(cron: string): string | null {
    const parts = cron.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 5) return 'Five fields: minute, hour, day of the month, month, weekday';
    for (let i = 0; i < FIELDS.length; i++) {
        const {name, min, max} = FIELDS[i];
        if (!fieldIsValid(parts[i], min, max)) return `${name} must be * or a number from ${min} to ${max}`;
    }
    return null;
}

function fieldIsValid(field: string, min: number, max: number): boolean {
    if (field === '*') return true;
    const step = /^\*\/(\d+)$/.exec(field);
    if (step) return Number(step[1]) > 0 && Number(step[1]) <= max;
    return field.split(',').every((item) => {
        const range = /^(\d+)-(\d+)$/.exec(item);
        if (range) {
            const lo = Number(range[1]);
            const hi = Number(range[2]);
            return lo >= min && hi <= max && lo <= hi;
        }
        if (!/^\d+$/.test(item)) return false;
        const value = Number(item);
        return value >= min && value <= max;
    });
}

/** A plain number from 0 to `max` (one or two digits), or null. */
function plain(field: string, max: number): number | null {
    if (!/^\d{1,2}$/.test(field)) return null;
    const value = Number(field);
    return value <= max ? value : null;
}
