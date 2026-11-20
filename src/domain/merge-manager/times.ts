/**
 * When the user's landed PRs are expected to merge, on the Merge manager's
 * page: by the rule the Merge queue section estimates with (#315, #441).
 *
 * One CI run is the median of the repository's recent green runs. The head
 * needs what is left of it: a run and a step while it is updated, the rest of
 * its run and half a step while its checks run, a minute once it merges. Every
 * PR waiting behind it needs one run and one step more. Held, Fixing and Needs
 * you are passed over, so they get no time and add none. In a queue lane the
 * queue's own number says how many turns are ahead, other people's PRs
 * included. From place 3 on an estimate is rough: rounded to 5 minutes, and
 * shown faded.
 *
 * The timeline lays each lane's turns out from now, one track per lane.
 *
 * Pure; times are epoch ms.
 */
import {MIN_ESTIMATE_MS, QUEUE_STEP_MS, expectedMinutes} from '../project/merge-queue';
import type {LandedView} from './model';
import type {PageLane, PageRow} from './page';

const MINUTE = 60_000;

/** When a PR is expected to merge. */
export interface RowTime {
    /** When its own turn starts: now for the head, else when the turn ahead of it ends. */
    readonly from: number;
    /** When it merges; rounded to 5 minutes when rough. */
    readonly at: number;
    /** Minutes until `at`, as shown. */
    readonly minutes: number;
    readonly rough: boolean;
}

export interface LaneTimes {
    /** One CI run here; null with too few green runs to go by. */
    readonly runMs: number | null;
    /** By row key, only the rows that move: the head and the waiting ones. */
    readonly rows: ReadonlyMap<string, RowTime>;
    /** When the last of them merges; null with none. */
    readonly clearsAt: number | null;
}

export function laneTimes(lane: PageLane, runMs: number | null, now: number): LaneTimes {
    const rows = new Map<string, RowTime>();
    if (runMs === null) return {runMs, rows, clearsAt: null};
    const turn = runMs + QUEUE_STEP_MS;
    const head = lane.rows.find((row) => row.stage.kind === 'head') ?? null;
    const headLeft = head ? headLeftMs(head, runMs, now) : null;
    if (head && headLeft !== null) rows.set(head.key, rowTime(now, now + headLeft, 1, now));
    let last = now + (headLeft ?? 0);
    let place = head ? 1 : 0;
    for (const row of lane.rows) {
        if (row.stage.kind !== 'waiting') continue;
        if (lane.kind === 'queue') {
            // The queue's number counts other people's PRs too; a head that is not ours has half a run left, say.
            if (row.order === null) continue;
            const at = now + (headLeft ?? runMs / 2) + (row.order - 1) * turn;
            rows.set(row.key, rowTime(at - turn, at, row.order, now));
        } else {
            place += 1;
            rows.set(row.key, rowTime(last, last + turn, place, now));
            last += turn;
        }
    }
    const ends = [...rows.values()].map((time) => time.at);
    return {runMs, rows, clearsAt: ends.length > 0 ? Math.max(...ends) : null};
}

/** What is left of the head's turn. */
function headLeftMs(row: PageRow, runMs: number, now: number): number | null {
    if (row.stage.kind !== 'head') return null;
    switch (row.stage.step) {
        case 'updating':
            return runMs + QUEUE_STEP_MS;
        case 'checks': {
            const since = checksSince(row.landed);
            if (since === null) return runMs / 2;
            return Math.max(MIN_ESTIMATE_MS, runMs - (now - since) + QUEUE_STEP_MS / 2);
        }
        case 'merging':
            return MIN_ESTIMATE_MS;
    }
}

/** When the head's first deciding check started; null when none says. */
export function checksSince(pr: LandedView): number | null {
    const starts = (pr.facts?.checks ?? [])
        .map((check) => check.startedAt ?? null)
        .filter((at): at is number => at !== null);
    return starts.length > 0 ? Math.min(...starts) : null;
}

/** A rough time falls on the clock's 5 minutes too: "~14:50", not "~14:52". */
function rowTime(from: number, at: number, place: number, now: number): RowTime {
    const {minutes, rough} = expectedMinutes(at - now, place);
    const five = 5 * MINUTE;
    return {from, at: rough ? Math.round((now + minutes * MINUTE) / five) * five : at, minutes, rough};
}

// ── Words ──

/** "12 min", "1 h", "1 h 10 min". */
export function durationText(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / MINUTE));
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "in 5 min", or rough "in ~30 min". */
export function untilText(time: RowTime): string {
    return 'in ' + (time.rough ? '~' : '') + durationText(time.minutes * MINUTE);
}

/** Why a row has no time: it keeps its place, passed over until something changes; null for one that moves. */
export function stillText(row: PageRow): string | null {
    const {stage} = row;
    switch (stage.kind) {
        case 'held':
            switch (stage.reason.kind) {
                case 'review':
                    return 'keeps its place until it is reviewed';
                case 'approval':
                    return 'keeps its place until it is approved';
                case 'draft':
                    return 'keeps its place while a draft';
                case 'base':
                    return 'waits for its base to merge';
            }
            break;
        case 'fixing':
            return 'back in its place once fixed';
        case 'needsYou':
            return 'keeps its place until you act';
        default:
            return null;
    }
}

// ── The timeline ──

export interface TimelineBlock {
    readonly key: string;
    readonly number: number;
    /** Where it starts and ends, as fractions of the timeline's width. */
    readonly start: number;
    readonly end: number;
    readonly head: boolean;
    readonly rough: boolean;
}

/**
 * Parked PRs on a track: landed but passed over (Held, Fixing, Needs you),
 * so they take no time on the line. A flag stands where they keep their
 * place: at the end of the timed block they come after in their lane's
 * order (at the start for none). Several at one spot share one flag.
 */
export interface TimelineFlag {
    /** Where it stands, as a fraction of the timeline's width. */
    readonly at: number;
    /** The parked PRs it stands for, in lane order. */
    readonly keys: readonly string[];
    readonly numbers: readonly number[];
    /** The strongest of them: needs you over fixing over held. */
    readonly tone: 'needsYou' | 'fixing' | 'held';
    /** "#498 fix errand stopped · #511 held until approved". */
    readonly title: string;
}

export interface TimelineTrack {
    readonly repository: string;
    readonly blocks: readonly TimelineBlock[];
    readonly flags: readonly TimelineFlag[];
}

export interface Timeline {
    readonly from: number;
    readonly to: number;
    /** The times the timeline marks, between `from` and `to`. */
    readonly ticks: readonly number[];
    readonly tracks: readonly TimelineTrack[];
}

/** The shortest and the longest stretch the timeline shows. */
const SPAN_MIN_MS = 60 * MINUTE;
const SPAN_MAX_MS = 4 * 60 * MINUTE;

/**
 * Each lane's turns from now: at least the next hour, and as far as the last
 * merge (in half hours, four hours at most). Null when no lane has a time.
 */
export function timeline(
    lanes: readonly PageLane[],
    times: ReadonlyMap<string, LaneTimes>,
    now: number,
): Timeline | null {
    const timed = lanes.filter((lane) => (times.get(lane.repository)?.rows.size ?? 0) > 0);
    if (timed.length === 0) return null;
    const last = Math.max(...timed.map((lane) => times.get(lane.repository)!.clearsAt ?? now));
    const halfHour = 30 * MINUTE;
    const span = Math.min(SPAN_MAX_MS, Math.max(SPAN_MIN_MS, Math.ceil((last - now) / halfHour) * halfHour));
    const to = now + span;
    const tick = span <= SPAN_MIN_MS ? 15 * MINUTE : span <= 2 * SPAN_MIN_MS ? halfHour : SPAN_MIN_MS;
    const ticks: number[] = [];
    for (let at = Math.ceil(now / tick) * tick; at < to; at += tick) if (at > now) ticks.push(at);
    const fraction = (at: number): number => Math.min(1, Math.max(0, (at - now) / span));
    return {
        from: now,
        to,
        ticks,
        tracks: timed.map((lane) => {
            const rows = times.get(lane.repository)!.rows;
            return {
                repository: lane.repository,
                flags: [],
                blocks: lane.rows.flatMap((row) => {
                    const time = rows.get(row.key);
                    if (!time || time.from >= to) return [];
                    return [
                        {
                            key: row.key,
                            number: row.number,
                            start: fraction(time.from),
                            end: fraction(time.at),
                            head: row.stage.kind === 'head',
                            rough: time.rough,
                        },
                    ];
                }),
            };
        }),
    };
}
