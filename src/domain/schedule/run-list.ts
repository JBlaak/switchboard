/**
 * A schedule's runs as its page lists them, newest first, with a marker
 * wherever the prompt changed between two runs ("Prompt changed to v3, Thu
 * 16:10: skip warnings with no users"), so a run reads against the prompt
 * it ran with. A version saved since the newest run gets its marker on top.
 *
 * Also the prompt card's line: "v3 · edited Thu · 3 runs since".
 */
import type {PromptVersion, ScheduleRun} from './manager';
import {dayAndClock, editedText} from './times';

export type RunListItem =
    | {readonly kind: 'run'; readonly run: ScheduleRun}
    | {readonly kind: 'promptChanged'; readonly version: number; readonly text: string};

/** "Prompt changed to v3, Thu 16:10: skip warnings with no users". */
export function promptChangedText(version: number, versions: readonly PromptVersion[], now: number): string {
    const saved = versions.find((entry) => entry.version === version);
    if (!saved) return `Prompt changed to v${version}`;
    const when = dayAndClock(saved.savedAt, now);
    return saved.note
        ? `Prompt changed to v${version}, ${when}: ${saved.note}`
        : `Prompt changed to v${version}, ${when}`;
}

/**
 * `runs` newest first, with a marker above the first run of each newer
 * version; `current` is the prompt's version now.
 */
export function runListItems(
    runs: readonly ScheduleRun[],
    versions: readonly PromptVersion[],
    current: number,
    now: number,
): RunListItem[] {
    const items: RunListItem[] = [];
    let above = current;
    for (const run of runs) {
        if (run.promptVersion !== above) {
            items.push({kind: 'promptChanged', version: above, text: promptChangedText(above, versions, now)});
        }
        items.push({kind: 'run', run});
        above = run.promptVersion;
    }
    return items;
}

/** The items down to the `count`th run, for Show older: a marker below the last run shown goes with the runs it heads. */
export function firstRunItems(items: readonly RunListItem[], count: number): RunListItem[] {
    const shown: RunListItem[] = [];
    let runs = 0;
    for (const item of items) {
        if (item.kind === 'run') {
            if (runs === count) break;
            runs++;
        }
        shown.push(item);
    }
    while (shown.length > 0 && shown[shown.length - 1].kind !== 'run' && runs === count) shown.pop();
    return shown;
}

/** "v3 · edited Thu · 3 runs since". */
export function promptLine(
    runs: readonly ScheduleRun[],
    versions: readonly PromptVersion[],
    current: number,
    now: number,
): string {
    const saved = versions.find((entry) => entry.version === current);
    const since = runs.filter((run) => run.promptVersion === current && run.status !== 'skipped').length;
    return [
        `v${current}`,
        ...(saved ? [editedText(saved.savedAt, now)] : []),
        `${since} ${since === 1 ? 'run' : 'runs'} since`,
    ].join(' · ');
}
