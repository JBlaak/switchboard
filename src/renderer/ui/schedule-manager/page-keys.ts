/**
 * What a key does on the Schedule manager's page. On the overview: J/K (or
 * ↓/↑) move through the schedules, ⏎ opens the chosen one's page, R runs it
 * now, P pauses or turns it on, E opens its page at the prompt, S marks its
 * last run seen, N starts a new schedule. On a schedule's page: J/K move
 * through its runs, ⏎ unfolds the chosen one, S marks it seen, C carries it
 * on in a session, and R, P, E and N as on the overview, for this schedule.
 *
 * Esc is the page's own (schedule page → overview → what it covered). Only
 * keys without ⌘, ⌃ or ⌥ reach this, never one typed into a field. Pure, so
 * it is tested in node; the page carries the answer out.
 */
import type {ScheduleRun, ScheduleSummary} from '../../../domain/schedule/manager';

export type ScheduleKeyAction =
    | {readonly kind: 'step'; readonly step: 1 | -1}
    | {readonly kind: 'new'}
    | {readonly kind: 'open' | 'runNow' | 'pause' | 'editPrompt'; readonly key: string}
    | {readonly kind: 'seen' | 'toggleRun' | 'carryOn'; readonly run: ScheduleRun};

/** The letters the page keeps for itself, even where the selection does not offer them: N is New, never a quick session. */
export const PAGE_LETTERS: ReadonlySet<string> = new Set(['j', 'k', 'r', 'p', 'e', 's', 'n', 'c']);

function step(key: string): ScheduleKeyAction | null {
    if (key === 'j' || key === 'ArrowDown') return {kind: 'step', step: 1};
    if (key === 'k' || key === 'ArrowUp') return {kind: 'step', step: -1};
    if (key === 'n') return {kind: 'new'};
    return null;
}

/** A key on the overview, with `selected` the chosen schedule. */
export function overviewKeyAction(key: string, selected: ScheduleSummary | null): ScheduleKeyAction | null {
    const moved = step(key);
    if (moved || !selected) return moved;
    switch (key) {
        case 'Enter':
            return {kind: 'open', key: selected.key};
        case 'r':
            return {kind: 'runNow', key: selected.key};
        case 'p':
            return {kind: 'pause', key: selected.key};
        case 'e':
            return {kind: 'editPrompt', key: selected.key};
        case 's':
            return selected.last && !selected.last.seen && selected.last.status !== 'running'
                ? {kind: 'seen', run: selected.last}
                : null;
        default:
            return null;
    }
}

/** A key on `scheduleKey`'s page, with `run` the chosen run. */
export function scheduleKeyAction(key: string, scheduleKey: string, run: ScheduleRun | null): ScheduleKeyAction | null {
    const moved = step(key);
    if (moved) return moved;
    switch (key) {
        case 'r':
            return {kind: 'runNow', key: scheduleKey};
        case 'p':
            return {kind: 'pause', key: scheduleKey};
        case 'e':
            return {kind: 'editPrompt', key: scheduleKey};
    }
    if (!run) return null;
    switch (key) {
        case 'Enter':
            return {kind: 'toggleRun', run};
        case 's':
            return run.seen || run.status === 'running' ? null : {kind: 'seen', run};
        case 'c':
            return run.sessionId ? {kind: 'carryOn', run} : null;
        default:
            return null;
    }
}
