/**
 * The Schedule manager's times, in the words its page uses: when a run comes
 * ("tonight 03:00", "tomorrow 09:00", "Mon 06:30"), how far off that is
 * ("in 15 h"), when a run was ("Last night", "Sat 03:00"), how long it took
 * and how much of the week it used.
 *
 * All local time; `now` and every time are epoch ms.
 */
import {clockText} from './cadence';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The night runs: from 22:00 to 08:00 the next morning. */
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 8;

/** Local midnight of `at`'s day. */
export function dayStartOf(at: number): number {
    const date = new Date(at);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "03:00". */
export function clockOf(at: number): string {
    const date = new Date(at);
    return clockText(date.getHours(), date.getMinutes());
}

/** Whole local days from `now`'s day to `at`'s (negative for the past). */
function daysBetween(now: number, at: number): number {
    return Math.round((dayStartOf(at) - dayStartOf(now)) / DAY);
}

/** "23 Oct". */
export function shortDate(at: number): string {
    const date = new Date(at);
    return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** "Sat 03:00", or "12 Oct 03:00" past a week. */
export function dayAndClock(at: number, now: number): string {
    const days = daysBetween(now, at);
    const day = Math.abs(days) < 7 ? WEEKDAYS[new Date(at).getDay()] : shortDate(at);
    return `${day} ${clockOf(at)}`;
}

/**
 * The night `at` belongs to, by the day it started on: 22:00 to 08:00, so
 * 03:00 belongs to the night before. Null outside the night.
 */
function nightOf(at: number): number | null {
    const hour = new Date(at).getHours();
    if (hour >= NIGHT_START_HOUR) return dayStartOf(at);
    if (hour < NIGHT_END_HOUR) return dayStartOf(dayStartOf(at) - HOUR);
    return null;
}

/** The night ahead, or the one going now: by the day it starts on. */
function tonightOf(now: number): number {
    return nightOf(now) ?? dayStartOf(now);
}

/** When a run comes: "tonight 03:00", "today 14:00", "tomorrow 09:00", "Mon 06:30", "2 Dec 03:00". */
export function nextRunText(at: number, now: number): string {
    const night = nightOf(at);
    if (night !== null && night === tonightOf(now) && at >= now) return `tonight ${clockOf(at)}`;
    const days = daysBetween(now, at);
    if (days === 0) return `today ${clockOf(at)}`;
    if (days === 1) return `tomorrow ${clockOf(at)}`;
    if (days > 1 && days < 7) return `${WEEKDAYS[new Date(at).getDay()]} ${clockOf(at)}`;
    return `${shortDate(at)} ${clockOf(at)}`;
}

/** How far off: "in 40 min", "in 15 h", "in 3 days"; "now" when due. */
export function untilText(at: number, now: number): string {
    const ms = at - now;
    if (ms < MINUTE) return 'now';
    if (ms < HOUR) return `in ${Math.round(ms / MINUTE)} min`;
    if (ms < 2 * DAY) return `in ${Math.round(ms / HOUR)} h`;
    return `in ${Math.round(ms / DAY)} days`;
}

/** When a run was, for its row: "Last night" over "Sun 03:00", or "Sat 03:00" alone. */
export function runWhen(at: number, now: number): {readonly title: string; readonly sub: string | null} {
    // In the small hours, the night going now is the one just slept through.
    const lastNight = nightOf(now) === null ? lastNightWindow(now) : tonightWindow(now);
    if (at >= lastNight.start && at < lastNight.end && at <= now)
        return {title: 'Last night', sub: dayAndClock(at, now)};
    if (daysBetween(now, at) === 0) return {title: `Today ${clockOf(at)}`, sub: null};
    return {title: dayAndClock(at, now), sub: null};
}

/** "edited Thu", "edited today", "edited 12 Oct". */
export function editedText(at: number, now: number): string {
    const days = daysBetween(now, at);
    if (days === 0) return 'edited today';
    if (days === -1) return 'edited yesterday';
    if (days > -7) return `edited ${WEEKDAYS[new Date(at).getDay()]}`;
    return `edited ${shortDate(at)}`;
}

/** A run's length: "<1 min", "23 min", "1 h 5 min". */
export function minutesText(minutes: number): string {
    if (minutes < 1) return '<1 min';
    const rounded = Math.round(minutes);
    if (rounded < 60) return `${rounded} min`;
    const rest = rounded % 60;
    return rest === 0 ? `${Math.floor(rounded / 60)} h` : `${Math.floor(rounded / 60)} h ${rest} min`;
}

/** A share of the week: "<1%", "~3%". */
export function shareText(percent: number): string {
    if (percent < 1) return '<1%';
    return `~${Math.round(percent)}%`;
}

/** A run's length in minutes, once it has started and ended (or `now` while it runs). */
export function runMinutes(run: {startedAt: number | null; endedAt: number | null}, now: number): number | null {
    if (run.startedAt === null) return null;
    return ((run.endedAt ?? now) - run.startedAt) / MINUTE;
}

/** The share of the week a run used, when both ends were read. */
export function runShare(run: {weekBefore: number | null; weekAfter: number | null}): number | null {
    if (run.weekBefore === null || run.weekAfter === null) return null;
    return Math.max(0, run.weekAfter - run.weekBefore);
}

/** `HH:MM` as minutes past midnight; null when it is not one. */
export function clockMinutes(clock: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
    if (!match) return null;
    const [hours, minutes] = [Number(match[1]), Number(match[2])];
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** A night on the clock: 22:00 to 08:00, epoch ms. */
export interface NightWindow {
    readonly start: number;
    readonly end: number;
}

function windowFrom(day: number): NightWindow {
    const date = new Date(day);
    const [y, m, d] = [date.getFullYear(), date.getMonth(), date.getDate()];
    return {start: new Date(y, m, d, NIGHT_START_HOUR).getTime(), end: new Date(y, m, d + 1, NIGHT_END_HOUR).getTime()};
}

/** The night ahead, or the one going now. */
export function tonightWindow(now: number): NightWindow {
    return windowFrom(tonightOf(now));
}

/** The night before tonight's. */
export function lastNightWindow(now: number): NightWindow {
    const day = new Date(tonightOf(now));
    return windowFrom(new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1).getTime());
}
