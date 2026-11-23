/**
 * A schedule's cron in plain English, as the Schedule manager says it:
 * "Every night at 03:00", "Weekdays at 06:30", "Every Monday at 09:00",
 * "Every hour at :15", "Every 10 minutes".
 *
 * Only the shapes people write are put in words; anything else is shown as
 * the cron itself, which is still right, only less friendly.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** From 21:00 to 05:59 a daily run is a nightly one. */
function isNightHour(hour: number): boolean {
    return hour >= 21 || hour < 6;
}

function plainNumber(field: string, max: number): number | null {
    if (!/^\d{1,2}$/.test(field)) return null;
    const n = Number(field);
    return n <= max ? n : null;
}

function step(field: string): number | null {
    const match = /^\*\/(\d+)$/.exec(field);
    return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

/** `1-5`, `1,3,5`, `0` or `7` as the days they name (0 is Sunday, so is 7); null for anything else. */
function weekdays(field: string): number[] | null {
    const days = new Set<number>();
    for (const part of field.split(',')) {
        const range = /^(\d)-(\d)$/.exec(part);
        if (range) {
            const [from, to] = [Number(range[1]), Number(range[2])];
            if (from > to || to > 7) return null;
            for (let day = from; day <= to; day++) days.add(day % 7);
            continue;
        }
        const day = plainNumber(part, 7);
        if (day === null) return null;
        days.add(day % 7);
    }
    return [...days].sort((a, b) => a - b);
}

function ordinal(n: number): string {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function listed(words: readonly string[]): string {
    return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function clockText(hour: number, minute: number): string {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function describeCron(cron: string): string {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return cron.trim();
    const [minuteField, hourField, dayField, monthField, weekdayField] = fields;
    if (monthField !== '*') return cron.trim();

    const minute = plainNumber(minuteField, 59);
    const everyMinutes = step(minuteField);
    if (minuteField === '*' && hourField === '*' && dayField === '*' && weekdayField === '*') return 'Every minute';
    if (everyMinutes !== null && hourField === '*' && dayField === '*' && weekdayField === '*') {
        return `Every ${everyMinutes} minutes`;
    }
    if (minute === null) return cron.trim();

    const everyHours = step(hourField);
    if (dayField === '*' && weekdayField === '*') {
        if (hourField === '*') return `Every hour at :${String(minute).padStart(2, '0')}`;
        if (everyHours !== null) {
            return minute === 0
                ? `Every ${everyHours} hours`
                : `Every ${everyHours} hours at :${String(minute).padStart(2, '0')}`;
        }
    }

    const hour = plainNumber(hourField, 23);
    if (hour === null) return cron.trim();
    const at = clockText(hour, minute);

    if (weekdayField === '*') {
        if (dayField === '*') return isNightHour(hour) ? `Every night at ${at}` : `Every day at ${at}`;
        const day = plainNumber(dayField, 31);
        return day !== null && day > 0 ? `Monthly on the ${ordinal(day)} at ${at}` : cron.trim();
    }
    if (dayField !== '*') return cron.trim();

    const days = weekdays(weekdayField);
    if (!days || days.length === 0) return cron.trim();
    if (days.length === 7) return isNightHour(hour) ? `Every night at ${at}` : `Every day at ${at}`;
    if (days.join() === '1,2,3,4,5') return `Weekdays at ${at}`;
    if (days.join() === '0,6') return `Weekends at ${at}`;
    if (days.length === 1) return `Every ${DAYS[days[0]]} at ${at}`;
    // Monday first, as a week is read.
    const mondayFirst = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    return `${listed(mondayFirst.map((day) => DAYS[day] + 's'))} at ${at}`;
}
