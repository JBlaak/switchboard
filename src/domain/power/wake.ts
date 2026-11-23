/**
 * The Mac's repeating wake, as `pmset -g sched` prints it and `pmset repeat`
 * sets it, for the Schedule manager: a nightly run only happens when the Mac
 * is awake for it.
 *
 * `pmset -g sched` lists the repeating events first, one per line, with the
 * time in the 12-hour clock:
 *
 *     Repeating power events:
 *       wakepoweron at 2:55AM every day
 *       shutdown at 11:00PM weekdays only
 *     Scheduled power events:
 *      [0]  wake at 11/24/2026 03:00:00 by 'com.apple.alarm.user-visible-…'
 *
 * Only the repeating section counts: the scheduled ones below it are one-off
 * wakes other apps ask for. `pmset repeat wakeorpoweron …` prints back as
 * `wakepoweron`; a plain `wake` counts too.
 */

const REPEATING_HEADER = /^\s*Repeating power events:\s*$/i;
const WAKE_LINE = /^\s*(?:wake|wakepoweron|wakeorpoweron)\s+at\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?\b/i;

/** The repeating wake's time as `HH:MM` (24-hour), or null when none is set. */
export function parseRepeatingWake(schedOutput: string): string | null {
    let inRepeating = false;
    for (const line of schedOutput.split('\n')) {
        if (REPEATING_HEADER.test(line)) {
            inRepeating = true;
            continue;
        }
        // Another section's header ends the repeating one.
        if (inRepeating && /^\S.*:\s*$/.test(line)) break;
        if (!inRepeating) continue;
        const match = WAKE_LINE.exec(line);
        if (!match) continue;
        let hour = Number(match[1]);
        const minute = Number(match[2]);
        const half = match[3]?.toUpperCase();
        if (half === 'AM' && hour === 12) hour = 0;
        if (half === 'PM' && hour !== 12) hour += 12;
        if (hour > 23 || minute > 59) continue;
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    return null;
}

/** Whether `at` is a time of day as the page sends it, `HH:MM`. */
export function isClockTime(at: string): boolean {
    const match = /^(\d{2}):(\d{2})$/.exec(at);
    return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/**
 * The `pmset` arguments that wake (or power on) the Mac at `at` every day,
 * or (null) clear the repeating events. `pmset repeat` holds one wake-type
 * event, so setting one replaces the one before.
 */
export function repeatWakeArgs(at: string | null): string[] {
    if (at === null) return ['repeat', 'cancel'];
    if (!isClockTime(at)) throw new Error(`not a time of day: ${at}`);
    return ['repeat', 'wakeorpoweron', 'MTWRFSU', `${at}:00`];
}

/** Whether osascript's error says the user cancelled the administrator prompt. */
export function promptCancelled(stderr: string): boolean {
    return /User cancell?ed|\(-128\)/i.test(stderr);
}
