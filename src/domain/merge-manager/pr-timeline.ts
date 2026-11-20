/**
 * Each PR's own timeline on the Merge manager's page: always the same seven
 * stations in the same order, landed or not, and one sentence on what is
 * happening now.
 *
 *   Opened · Review · Checks · Landed · In line · Head · Merged
 *
 * At the head the line to Merged splits into its three steps: update,
 * checks, merge.
 *
 * Marks: `done` (reached), `now` (where it is, in its group's colour),
 * `stopped` (needs you, on the station that caused it), `conflict`,
 * `fixing` (a fix errand at work), `held` (passed over, place kept), `todo`.
 *
 * Where the mark sits, per stage:
 *
 * | Stage / status                    | Mark                                                  |
 * |-----------------------------------|-------------------------------------------------------|
 * | Needs you: changes / thread       | Review `stopped`                                      |
 * | Needs you: errand stopped/refused | Head `stopped` (the head step it failed on `stopped`) |
 * | Held: approval / review           | Review `held`, In line `held`                         |
 * | Held: base / draft                | In line `held`                                        |
 * | Waiting                           | In line `now` (`conflict` when it will conflict)      |
 * | Head                              | Head `now`, its step `now`                            |
 * | Fixing                            | Head `fixing`, the step it mends `fixing`             |
 * | Not landed: draft                 | Opened `now`                                          |
 * | Not landed: in review / none      | Review `now` / `held` (nobody asked)                  |
 * | Not landed: changes asked         | Review `stopped`                                      |
 * | Not landed: checks running        | Checks `now`                                          |
 * | Not landed: checks failing        | Checks `stopped`                                      |
 * | Not landed: conflicts             | Landed `conflict`                                     |
 * | Not landed: ready                 | Landed `now` (the next move is Land it)               |
 *
 * Everything before the mark is `done` unless the table says otherwise;
 * everything after it `todo`.
 *
 * Pure; times are epoch ms.
 */
import type {BarTiming} from './progress';
import type {OpenPullRequest} from './not-landed';
import type {PageRow} from './page';
import type {RowTime} from './times';

export type StationId = 'opened' | 'review' | 'checks' | 'landed' | 'line' | 'head' | 'merged';

export const STATION_IDS: readonly StationId[] = ['opened', 'review', 'checks', 'landed', 'line', 'head', 'merged'];

export const STATION_LABELS: Readonly<Record<StationId, string>> = {
    opened: 'Opened',
    review: 'Review',
    checks: 'Checks',
    landed: 'Landed',
    line: 'In line',
    head: 'Head',
    merged: 'Merged',
};

export type StationMark = 'done' | 'now' | 'stopped' | 'conflict' | 'fixing' | 'held' | 'todo';

export interface Station {
    readonly id: StationId;
    readonly label: string;
    readonly mark: StationMark;
    /** One short line under it: "10:14", "@ana", "2nd", "~14:52"; null for nothing. */
    readonly sub: string | null;
    /** How long the stretch after it took, over the line ("3 h 31 min"); null when not known or not done. */
    readonly duration: string | null;
}

export type HeadPartId = 'update' | 'checks' | 'merge';

export interface HeadPart {
    readonly id: HeadPartId;
    /** "update", "checks 5 of 8", "merge". */
    readonly label: string;
    readonly mark: StationMark;
}

/** The stretch that runs now and fills toward its expected time (`TimedBar`): after a station, or one of the head's parts. */
export interface LiveStretch {
    readonly after: StationId | HeadPartId;
    readonly timing: BarTiming;
}

export interface PrTimeline {
    /** Always seven, in `STATION_IDS`' order. */
    readonly stations: readonly Station[];
    /** The head's three steps while it is the head, fixing at the head or stopped there; null otherwise. */
    readonly headParts: readonly HeadPart[] | null;
    readonly live: LiveStretch | null;
    /** "Checks running on the head · 5 of 8 done · merges in ~4 min". */
    readonly now: string;
    /** For a screen reader: "Opened done, Review done, …, Head now, Merged to come". */
    readonly label: string;
}

/**
 * A landed PR's timeline. `time` is its expected merge (`laneTimes`), absent
 * for a passed-over one; `runMs` one CI run in its repository, for the
 * checks' bar.
 */
export function landedTimeline(
    row: PageRow,
    time: RowTime | undefined,
    runMs: number | null,
    now: number,
): PrTimeline {
    void row;
    void time;
    void runMs;
    void now;
    throw new Error('not built yet');
}

/** A not landed PR's timeline: Landed and after are still to come. */
export function notLandedTimeline(pr: OpenPullRequest, now: number): PrTimeline {
    void pr;
    void now;
    throw new Error('not built yet');
}
