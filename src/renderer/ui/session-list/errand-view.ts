/**
 * What an errand's row says, on the Automatic shelf and wherever an errand's
 * session shows as an ordinary row (a stuck one in Blocked, any of them
 * among a filter's matches): one place, so the two never drift apart. And
 * what the shelf as a whole shows: its sections, its count and its summary.
 */
import {shortRepository, shortTitle, type ErrandEntry} from '../../../domain/session/errand-shelf';
import {
    anyScheduleOn,
    comingUp,
    listedRuns,
    nextScheduledAt,
    runTime,
    upcomingTime,
    type ComingUpRun,
    type ShelfRun,
} from '../../../domain/schedule/shelf';
import {isEndedRun, type LaidErrand} from '../../state/session-list-layout';
import type {ScheduleManagerFacts} from '../../../domain/schedule/manager';

/**
 * The row's name: the PR and what the errand is doing on it, `#431 · fixing
 * checks`, for a triage the bug it looks into, `Triage · TypeError: x is
 * undefined`, and for a scheduled run its schedule and how it is going,
 * `Bugsnag sweep · limit hit`. A stuck one says so the way the others do: its
 * red label.
 */
export function errandRowName(errand: ErrandEntry): string {
    if (errand.run) return runRowName(errand.run);
    if (errand.number === null) return `Triage · ${shortTitle(errand.title ?? '')}`;
    return `#${errand.number} · ${errand.doing}`;
}

/** Where it runs: the VM merging was handed off to, or the repository's short name on this Mac. */
export function errandPlace(errand: ErrandEntry): string {
    return errand.host ?? shortRepository(errand.repository);
}

/** The errand's pull request on GitHub; null for a triage, which has none. */
export function errandPullRequestUrl(errand: ErrandEntry): string | null {
    if (errand.number === null) return null;
    return `https://github.com/${errand.repository}/pull/${errand.number}`;
}

/** A scheduled run's name on a row: its schedule and how it is going, `Bugsnag sweep · 03:00`. */
export function runRowName(run: ShelfRun): string {
    return `${run.name} · ${run.doing}`;
}

/**
 * What an errand's meta line starts with where it shows as an ordinary row:
 * "errand", or for a scheduled run "scheduled" and why it needs you,
 * `scheduled · its 20 min limit`.
 */
export function errandLead(errand: ErrandEntry): string {
    if (!errand.run) return 'errand';
    return `scheduled · ${errand.run.reason ?? errand.run.doing}`;
}

/**
 * One row of the shelf: an errand's session (`LaidErrand`), or a scheduled
 * run the shelf has no session row for: one that never started (missed,
 * skipped), or whose session the list does not hold.
 */
export type ShelfRow =
    {readonly kind: 'session'; readonly laid: LaidErrand} | {readonly kind: 'run'; readonly run: ShelfRun};

/** The header's right side: how many need you (in red), then the rest, `3 to read · 1 running`. */
export interface AutomaticShelfSummary {
    readonly needsYou: string | null;
    readonly rest: string | null;
}

/** What the Automatic shelf shows. */
export interface AutomaticShelf {
    /** The errands and the scheduled runs going now; the ones that need you first. */
    readonly running: readonly ShelfRow[];
    /** The scheduled runs that ended and are not seen yet, newest first. */
    readonly lastNight: readonly ShelfRow[];
    /** The next schedule times, dim: no session yet. */
    readonly comingUp: readonly ComingUpRun[];
    /** Every row the shelf holds, as the header counts them. */
    readonly count: number;
    readonly summary: AutomaticShelfSummary;
    /** Link to the Schedule manager: there are schedules, or runs of them. */
    readonly scheduleManagerLink: boolean;
    /** Link to the Merge manager: an errand of its, or of the merge queue, is on the shelf. */
    readonly mergeManagerLink: boolean;
}

/**
 * The Automatic shelf from the errands the layout put on it (in its order,
 * see `orderErrands`) and the Schedule manager's facts; null while it is
 * hidden. It shows while any errand or scheduled run is listed, or while any
 * schedule is on, so its folded line can say when the night starts; never
 * while filtering, when errands show among the matches.
 */
export function automaticShelf(
    errands: readonly LaidErrand[],
    schedules: ScheduleManagerFacts | null,
    now: number,
    filtering: boolean,
): AutomaticShelf | null {
    if (filtering) return null;
    const onShelf = new Set(errands.map(({errand}) => errand.sessionId));
    const loose = listedRuns(schedules).filter((run) => run.sessionId === null || !onShelf.has(run.sessionId));
    const asRow = (run: ShelfRun): ShelfRow => ({kind: 'run', run});

    const running: ShelfRow[] = [
        ...errands.filter(({errand}) => !isEndedRun(errand)).map((laid): ShelfRow => ({kind: 'session', laid})),
        ...loose.filter((run) => run.status === 'running').map(asRow),
    ];
    const lastNight: ShelfRow[] = [
        ...errands.filter(({errand}) => isEndedRun(errand)).map((laid): ShelfRow => ({kind: 'session', laid})),
        ...loose.filter((run) => run.status !== 'running').map(asRow),
    ].sort((a, b) => runTime(shelfRun(b)!) - runTime(shelfRun(a)!));
    const next = comingUp(schedules, now);
    const count = running.length + lastNight.length + next.length;
    if (count === 0 && !anyScheduleOn(schedules)) return null;

    return {
        running,
        lastNight,
        comingUp: next,
        count,
        summary: summarize(running, lastNight, nextScheduledAt(schedules, now), now),
        scheduleManagerLink: (schedules?.schedules.length ?? 0) > 0 || loose.length > 0,
        mergeManagerLink: errands.some(({errand}) => errand.owner === 'merge-manager' || errand.owner === 'queue'),
    };
}

/** A row's scheduled run, if it is one. */
export function shelfRun(row: ShelfRow): ShelfRun | null {
    return row.kind === 'run' ? row.run : (row.laid.errand.run ?? null);
}

/** Whether a row needs you. */
export function rowNeedsYou(row: ShelfRow): boolean {
    return row.kind === 'run' ? row.run.needsYou : row.laid.errand.needsYou;
}

/**
 * "1 needs you" in red, then "3 to read" (every run Last night holds) and
 * "1 running"; while nothing needs you and nothing is left to read, also
 * when the next schedule runs, "next 03:00".
 */
function summarize(
    running: readonly ShelfRow[],
    lastNight: readonly ShelfRow[],
    next: number | null,
    now: number,
): AutomaticShelfSummary {
    const stuck = [...running, ...lastNight].filter(rowNeedsYou).length;
    const going = running.filter((row) => !rowNeedsYou(row)).length;
    const rest: string[] = [];
    if (lastNight.length > 0) rest.push(`${lastNight.length} to read`);
    if (going > 0) rest.push(`${going} running`);
    if (stuck === 0 && lastNight.length === 0 && next !== null) rest.push(`next ${upcomingTime(next, now)}`);
    return {needsYou: stuck > 0 ? `${stuck} needs you` : null, rest: rest.length > 0 ? rest.join(' · ') : null};
}
