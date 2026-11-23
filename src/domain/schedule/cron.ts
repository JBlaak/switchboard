/**
 * Matching a 5-field cron expression against a moment.
 *
 * The scheduler ticks once a minute and asks each schedule whether now is its
 * time, rather than computing next-run times — which means a missed tick is a
 * skipped run rather than a burst of catch-up runs, and a schedule edited
 * mid-flight takes effect on the next minute. The one time it looks back is
 * on start and on wake, for the latest time it slept through (`latestCronTime`).
 *
 * Supports `*`, steps (`*` followed by `/5`), lists (`1,3,5`) and ranges (`1-5`).
 */

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

/** A cron expression split into its fields; null when it does not have five. */
function cronFields(cronExpr: string): string[] | null {
    const parts = cronExpr.trim().split(/\s+/);
    return parts.length === 5 ? parts : null;
}

function dayMatches([, , dom, month, dow]: string[], at: Date): boolean {
    return fieldMatches(dom, at.getDate()) && fieldMatches(month, at.getMonth() + 1) && fieldMatches(dow, at.getDay());
}

export function cronMatches(cronExpr: string, now: Date): boolean {
    const fields = cronFields(cronExpr);
    if (!fields) return false;
    return (
        fieldMatches(fields[0], now.getMinutes()) && fieldMatches(fields[1], now.getHours()) && dayMatches(fields, now)
    );
}

const MINUTE_MS = 60_000;

/**
 * The latest minute in `(now − windowMs, now]` the cron matches, as epoch ms
 * at the start of that minute; null when none does.
 *
 * Walks back from now a day or an hour at a time past whole days and hours
 * that cannot match, and a minute at a time only inside an hour that can, so
 * a week's window of a nightly schedule takes a few dozen steps rather than
 * ten thousand. Local time, as the tick matches it.
 */
export function latestCronTime(cronExpr: string, now: number, windowMs: number): number | null {
    const fields = cronFields(cronExpr);
    if (!fields) return null;
    const floor = now - windowMs;
    let t = now - (((now % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
    while (t > floor) {
        const at = new Date(t);
        if (!dayMatches(fields, at)) {
            t = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - MINUTE_MS;
            continue;
        }
        if (!fieldMatches(fields[1], at.getHours())) {
            t = t - at.getMinutes() * MINUTE_MS - MINUTE_MS;
            continue;
        }
        if (fieldMatches(fields[0], at.getMinutes())) return t;
        t -= MINUTE_MS;
    }
    return null;
}
