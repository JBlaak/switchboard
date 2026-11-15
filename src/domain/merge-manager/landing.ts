/**
 * The Landing shelf: the user's landed PRs as one line under the session
 * list, and how long each still has to wait before it merges.
 *
 * - **Colours** are every place's (`stageTone`): purple merging or merged,
 *   green ready, yellow in progress or needs you, grey held, red an error.
 * - **Times** are estimates. A lane's cycle is how long one PR has taken to
 *   merge once it could start: the median, over the lane's merges the Merge
 *   manager still keeps, of the time from its landing or the merge before it,
 *   whichever was later, to its merge. A head has what its step leaves of a
 *   cycle; a waiting PR the head's rest plus a cycle for each place after it.
 *   A PR being fixed gets two cycles, marked approximate; a held one or one
 *   that needs you gets none, since nothing counts down until it is unblocked.
 * - **Pips**: one dot per PR in each lane, the user's filled, other people's
 *   hollow where a queue lane's numbers show they are there. A PR that merged
 *   in the last `JUST_MERGED_MS` keeps its dot, marked gone, so it can leave.
 *
 * Pure, so the tests hold it still. Times are epoch ms.
 */
import {MERGED_BUBBLE_MS} from './figure';
import {dayStart, pageLanes, type PageRow} from './page';
import {stageTone, type StageTone} from './stage-words';
import {checksSince} from './times';
import type {BarTiming} from './progress';
import type {LandedView, LaneKind, LaneView, MergeManagerState} from './model';

// ── Times ──

const MIN = 60_000;
/** A lane's cycle before it has merged anything the Merge manager kept. */
export const DEFAULT_CYCLE_MS = 15 * MIN;
const SHORTEST_CYCLE_MS = 3 * MIN;
const LONGEST_CYCLE_MS = 90 * MIN;
/** How long the ETA slot says what merged, and its dot stays to leave. */
export const JUST_MERGED_MS = 30_000;
/** At most this many of today's merges are listed. */
const MERGED_LISTED = 3;

/** How long a PR still has to wait; `approximate` when it depends on a fix. */
export interface LandingEta {
    readonly ms: number;
    readonly approximate: boolean;
}

/** How long one PR takes to merge in `lane` once it may start. */
export function laneCycle(lane: LaneView): number {
    const merges = lane.pullRequests
        .flatMap((pr) => (pr.stage.kind === 'merged' ? [{landedAt: pr.landedAt, at: pr.stage.at}] : []))
        .sort((a, b) => a.at - b.at);
    const spans = merges
        .map((merge, i) => merge.at - Math.max(merge.landedAt, i > 0 ? merges[i - 1]!.at : merge.landedAt))
        .filter((ms) => ms > 0);
    if (spans.length === 0) return DEFAULT_CYCLE_MS;
    return Math.min(LONGEST_CYCLE_MS, Math.max(SHORTEST_CYCLE_MS, median(spans)));
}

/** The checks' share of a cycle. */
const CHECKS_SHARE = 0.75;

/** What a head's step leaves of a cycle: most of it while updating, the checks' share while they run, a little to merge. */
function headLeft(row: PageRow, cycle: number): number {
    if (row.stage.kind !== 'head') return cycle;
    const left = (fraction: number): number => Math.max(MIN, Math.round(cycle * fraction));
    switch (row.stage.step) {
        case 'updating':
            return left(0.9);
        case 'checks': {
            const checks = row.landed.facts?.checks ?? [];
            const passed = checks.filter((check) => check.state === 'passed' || check.state === 'skipped').length;
            const done = checks.length > 0 ? passed / checks.length : 0;
            return left(0.1 + CHECKS_SHARE * (1 - done));
        }
        case 'merging':
            return left(0.05);
    }
}

/** Each row's time, in the lane's order. */
function laneEtas(rows: readonly PageRow[], cycle: number): (LandingEta | null)[] {
    const head = rows.find((row) => row.stage.kind === 'head');
    // Someone else's head in a queue lane is taken to be halfway through.
    const first = head ? headLeft(head, cycle) : Math.round(cycle / 2);
    let unplaced = 0;
    return rows.map((row) => {
        switch (row.stage.kind) {
            case 'head':
                return {ms: first, approximate: false};
            case 'waiting': {
                const place = row.landed.place;
                if (place !== null) return {ms: first + Math.max(0, place - 1) * cycle, approximate: false};
                unplaced++;
                return {ms: first + unplaced * cycle, approximate: true};
            }
            case 'fixing':
                return {ms: 2 * cycle, approximate: true};
            default:
                return null;
        }
    });
}

// ── The strip ──

/** One of the user's landed PRs on the shelf. */
export interface LandingRow {
    readonly key: string;
    readonly number: number;
    readonly title: string;
    readonly tone: StageTone;
    /** The stage's words, as the Merge manager's page says them. */
    readonly label: string;
    readonly eta: LandingEta | null;
    /** The head's checks done, 0–1; null for any other row, or before its checks are known. */
    readonly progress: number | null;
    /**
     * What that bar fills by: while the checks run, their share of the lane's
     * cycle from when the first started; otherwise it stays at `progress`.
     */
    readonly timing: BarTiming | number | null;
    /** The page's row, for opening its session. */
    readonly row: PageRow;
}

/** A dot on the folded line. */
export interface LandingPip {
    readonly key: string;
    readonly tone: StageTone;
    /** The user's own PR; other people's are drawn hollow. */
    readonly own: boolean;
    readonly head: boolean;
    /** A fix errand works on it. */
    readonly fixing: boolean;
    /** Merged a moment ago, on its way out. */
    readonly gone: boolean;
}

export interface LandingLane {
    readonly repository: string;
    readonly kind: LaneKind;
    readonly rows: readonly LandingRow[];
    readonly pips: readonly LandingPip[];
}

export interface LandingStrip {
    readonly lanes: readonly LandingLane[];
    /** The user's PRs still landed. */
    readonly count: number;
    /** The one that merges first; null when nothing counts down. */
    readonly next: LandingRow | null;
    /** When the last of those that count down merges; null when none does. */
    readonly allMerged: LandingEta | null;
    /** How many need the user (not counting errors). */
    readonly needsYou: number;
    /** Merged in the last `JUST_MERGED_MS`, newest; null otherwise. */
    readonly justMerged: LandedView | null;
    /** Today's merges, newest first, a few. */
    readonly merged: readonly LandedView[];
    /** Shown while anything is landed, or something merged in the last `MERGED_BUBBLE_MS`. */
    readonly visible: boolean;
}

export function landingStrip(state: MergeManagerState, now: number): LandingStrip {
    const pages = new Map(pageLanes(state).map((lane) => [lane.repository, lane]));
    const today = dayStart(now);
    const lanes = state.lanes
        .map((lane) => landingLane(lane, pages.get(lane.repository)?.rows ?? [], now))
        .filter((lane) => lane.pips.length > 0)
        .sort((a, b) => a.repository.localeCompare(b.repository));
    const rows = lanes.flatMap((lane) => lane.rows);
    const timed = rows.filter((row): row is LandingRow & {eta: LandingEta} => row.eta !== null);
    const merged = state.lanes
        .flatMap((lane) => lane.pullRequests)
        .filter((pr) => pr.stage.kind === 'merged' && mergedAt(pr) >= today)
        .sort((a, b) => mergedAt(b) - mergedAt(a));
    const latest = merged[0] ?? null;
    return {
        lanes,
        count: rows.length,
        next: timed.reduce<LandingRow | null>(
            (soonest, row) => (soonest && soonest.eta!.ms <= row.eta.ms ? soonest : row),
            null,
        ),
        allMerged: timed.reduce<LandingEta | null>(
            (last, row) =>
                !last || row.eta.ms > last.ms
                    ? {ms: row.eta.ms, approximate: row.eta.approximate || (last?.approximate ?? false)}
                    : {...last, approximate: last.approximate || row.eta.approximate},
            null,
        ),
        needsYou: rows.filter((row) => row.row.stage.kind === 'needsYou' && row.tone !== 'error').length,
        justMerged: latest && now - mergedAt(latest) < JUST_MERGED_MS ? latest : null,
        merged: merged.slice(0, MERGED_LISTED),
        visible: rows.length > 0 || (latest !== null && now - mergedAt(latest) < MERGED_BUBBLE_MS),
    };
}

function landingLane(lane: LaneView, pageRows: readonly PageRow[], now: number): LandingLane {
    const cycle = laneCycle(lane);
    const etas = laneEtas(pageRows, cycle);
    const rows = pageRows.map((row, i): LandingRow => {
        const checks = row.landed.facts?.checks ?? [];
        const passed = checks.filter((check) => check.state === 'passed' || check.state === 'skipped').length;
        const progress = row.stage.kind === 'head' && checks.length > 0 ? passed / checks.length : null;
        const running = row.stage.kind === 'head' && row.stage.step === 'checks';
        return {
            key: row.key,
            number: row.number,
            title: row.title,
            tone: stageTone(row.stage),
            label: row.stage.kind === 'head' ? 'Merging · ' + row.stage.step : row.words.label,
            eta: etas[i] ?? null,
            progress,
            timing:
                progress === null
                    ? null
                    : running
                      ? {actual: progress, startedAt: checksSince(row.landed), expectedMs: cycle * CHECKS_SHARE}
                      : progress,
            row,
        };
    });
    const leaving = lane.pullRequests.filter((pr) => pr.stage.kind === 'merged' && now - mergedAt(pr) < JUST_MERGED_MS);
    return {repository: lane.repository, kind: lane.kind, rows, pips: lanePips(lane.kind, rows, leaving)};
}

/** Others in a queue lane between the user's PRs are only known by the gaps in its numbers. */
const MOST_OTHERS = 6;

function lanePips(kind: LaneKind, rows: readonly LandingRow[], leaving: readonly LandedView[]): LandingPip[] {
    const own = (row: LandingRow): LandingPip => ({
        key: row.key,
        tone: row.tone,
        own: true,
        head: row.row.stage.kind === 'head',
        fixing: row.row.stage.kind === 'fixing',
        gone: false,
    });
    const gone = leaving.map((pr): LandingPip => ({
        key: pr.key,
        tone: 'merging',
        own: true,
        head: false,
        fixing: false,
        gone: true,
    }));
    if (kind !== 'queue') return [...gone, ...rows.map(own)];
    // A queue lane numbers everyone in it: fill the gaps before each of the user's places with others.
    const pips: LandingPip[] = [...gone];
    let at = 0;
    let others = 0;
    for (const row of rows) {
        const place = row.row.stage.kind === 'head' ? 1 : row.row.landed.place;
        if (place !== null) {
            for (let n = at + 1; n < place && others < MOST_OTHERS; n++, others++) {
                const other: LandingPip = {
                    key: `${row.key}~${n}`,
                    tone: n === 1 ? 'merging' : 'ready',
                    own: false,
                    head: n === 1,
                    fixing: false,
                    gone: false,
                };
                pips.push(other);
            }
            at = Math.max(at, place);
        }
        pips.push(own(row));
    }
    return pips;
}

function mergedAt(pr: LandedView): number {
    return pr.stage.kind === 'merged' ? pr.stage.at : 0;
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// ── Words ──

/** "<1m", "10m", "1h 50m", "2h"; "~35m" when approximate. */
export function etaText(eta: LandingEta): string {
    const minutes = Math.round(eta.ms / MIN);
    const text =
        eta.ms < MIN
            ? '<1m'
            : minutes < 60
              ? `${minutes}m`
              : minutes % 60 === 0
                ? `${minutes / 60}h`
                : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return (eta.approximate ? '~' : '') + text;
}

/** "10 min ago", "just now", "2h ago": how long since a merge. */
export function mergedAgo(pr: LandedView, now: number): string {
    const minutes = Math.floor((now - mergedAt(pr)) / MIN);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
}

/** What the folded line's right edge says when nothing counts down: why. */
export function stillText(strip: LandingStrip): {text: string; tone: StageTone} {
    const rows = strip.lanes.flatMap((lane) => lane.rows);
    if (rows.some((row) => row.tone === 'error')) return {text: 'failed', tone: 'error'};
    if (strip.needsYou > 0) return {text: 'needs you', tone: 'progress'};
    if (rows.some((row) => row.tone === 'blocked')) return {text: 'held', tone: 'blocked'};
    return {text: 'merged', tone: 'merging'};
}
