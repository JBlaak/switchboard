/**
 * The Mac's battery, as `pmset -g batt` prints it, for the phone (#194).
 *
 * A MacBook prints the source it draws from, then one line per battery:
 *
 *     Now drawing from 'AC Power'
 *      -InternalBattery-0 (id=22478947)	37%; charging; 1:47 remaining present: true
 *
 * The state after the percentage is `charging`, `finishing charge`,
 * `discharging`, `charged` or `AC attached` (plugged in, not charging). A Mac
 * without a battery prints only the first line, and that is not an error: the
 * phone just shows no battery.
 */
import type {MacBattery} from '../phone/protocol';

/** The internal battery's level and whether it is charging; null when the output names no battery. */
export function parsePmsetBattery(pmsetOutput: string): MacBattery | null {
    const match = /InternalBattery[^\t\n]*\t\s*(\d{1,3})%;\s*([^;\n]+)/.exec(pmsetOutput);
    if (!match) return null;
    const percent = Math.min(100, Number(match[1]));
    const state = match[2]!.trim().toLowerCase();
    return {percent, charging: state === 'charging' || state === 'finishing charge'};
}

export function sameBattery(a: MacBattery | null, b: MacBattery | null): boolean {
    if (a === null || b === null) return a === b;
    return a.percent === b.percent && a.charging === b.charging;
}
