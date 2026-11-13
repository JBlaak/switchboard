/**
 * The Merge manager's page (#439, for #432): what it shows of the lanes, read
 * from the state main pushes (`MergeManagerState`) and the page's own facts
 * (`MergeManagerPageFacts`).
 *
 * - **Tiles** count the user's own landed PRs by stage: Needs you, Fixing,
 *   Merging (yours as the head), Waiting, Held, Merged today, and the CI runs
 *   the Switchboard lane runner saved this week, an estimate: one run for each
 *   update not pushed to a waiting PR, each unfinished run cancelled behind
 *   the head and each conflict found by a local test rebase instead of a push.
 * - **Lanes** are grouped by repository, each with its kind. The head comes
 *   first, as a card; a Switchboard lane goes on in land order, a queue lane
 *   in the queue's order (then the rest in land order), with teammates'
 *   entries among the user's, faded. A lane with nothing of the user's still
 *   in it is left out.
 * - **Merged today** goes at the bottom, newest first.
 * - **Actions** per row: ⏎ opens the session or the errand, T Try again, N
 *   Nudge, U Unland, O the PR on GitHub; teammates' rows have Nudge only.
 *
 * Pure, so the tests hold it still. Times are epoch ms, days and weeks local.
 */
import {stageWords, type StageWords} from './stage-words';
import type {
    FixingCause,
    LandedView,
    LaneKind,
    LaneSaving,
    LaneStage,
    LaneStageKind,
    LaneView,
    MergeManagerState,
    TeammateEntry,
} from './model';

// ── What main answers for the page ──

/** A fix errand, as the page shows it. */
export interface ErrandView {
    /** The landed PR's key. */
    readonly key: string;
    /** The session it runs as now. */
    readonly sessionId: string;
    readonly cause: FixingCause;
    readonly startedAt: number;
    readonly state: 'running' | 'stopped' | 'finished';
    /** What it said when it finished; null before. */
    readonly note: string | null;
}

/** What the page shows besides the lanes, asked for as it opens and as the lanes change. */
export interface MergeManagerPageFacts {
    /** What the lane runner saved since the week began, by kind. */
    readonly savedThisWeek: Readonly<Record<LaneSaving, number>>;
    /** The same, by lower-case `owner/repo`. */
    readonly savedByRepository: Readonly<Record<string, Readonly<Record<LaneSaving, number>>>>;
    /** Every fix errand the Merge manager keeps, oldest first. */
    readonly errands: readonly ErrandView[];
    /** The local checkout of each lane's repository (by lower-case `owner/repo`), where a nudge's session starts. */
    readonly checkouts: Readonly<Record<string, string>>;
}

// ── Days and weeks ──

/** Local midnight at the start of `now`'s day. */
export function dayStart(now: number): number {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
}

/** Local midnight at the start of `now`'s week, which starts on Monday. */
export function weekStart(now: number): number {
    const day = new Date(dayStart(now));
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    return day.getTime();
}

// ── CI saved ──

/** CI runs saved: one per update not pushed, run cancelled and conflict found locally. An estimate. */
export function ciRunsSaved(saved: Readonly<Record<LaneSaving, number>> | null | undefined): number {
    if (!saved) return 0;
    return Object.values(saved).reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0);
}

/** "2 updates not pushed, 1 run cancelled, 1 conflict found by a local test rebase"; null when nothing was saved. */
export function savedText(saved: Readonly<Record<LaneSaving, number>> | null | undefined): string | null {
    if (!saved) return null;
    const parts: string[] = [];
    const n = (kind: LaneSaving): number => saved[kind] ?? 0;
    if (n('update-not-pushed') > 0) {
        parts.push(plural(n('update-not-pushed'), 'update', 'updates') + ' not pushed to waiting PRs');
    }
    if (n('run-cancelled') > 0) parts.push(plural(n('run-cancelled'), 'run', 'runs') + ' cancelled behind the head');
    if (n('conflict-found') > 0) {
        parts.push(plural(n('conflict-found'), 'conflict', 'conflicts') + ' found by a local test rebase');
    }
    return parts.length > 0 ? parts.join(', ') : null;
}

// ── Tiles ──

export interface MergeManagerTiles {
    readonly needsYou: number;
    readonly fixing: number;
    /** The user's PRs that are their lane's head. */
    readonly merging: number;
    readonly waiting: number;
    /** Waiting ones a test rebase found a conflict in. */
    readonly willConflict: number;
    readonly held: number;
    readonly mergedToday: number;
    /** When the last of today's merged; null when none did. */
    readonly lastMergedAt: number | null;
}

/** The tiles over the user's own landed PRs; Merged today counts from local midnight (`today`). */
export function mergeManagerTiles(state: MergeManagerState, today: number): MergeManagerTiles {
    const prs = state.lanes.flatMap((lane) => lane.pullRequests);
    const count = (kind: LaneStageKind): number => prs.filter((pr) => pr.stage.kind === kind).length;
    const merged = mergedToday(state, today);
    return {
        needsYou: count('needsYou'),
        fixing: count('fixing'),
        merging: count('head'),
        waiting: count('waiting'),
        willConflict: prs.filter((pr) => pr.stage.kind === 'waiting' && pr.stage.willConflict).length,
        held: count('held'),
        mergedToday: merged.length,
        lastMergedAt: merged.length > 0 ? stageAt(merged[0].stage) : null,
    };
}

/** The user's PRs that merged since `today` (local midnight), newest first. */
export function mergedToday(state: MergeManagerState, today: number): LandedView[] {
    return state.lanes
        .flatMap((lane) => lane.pullRequests)
        .filter((pr) => pr.stage.kind === 'merged' && pr.stage.at >= today)
        .sort((a, b) => stageAt(b.stage) - stageAt(a.stage));
}

function stageAt(stage: LaneStage): number {
    return stage.kind === 'merged' ? stage.at : 0;
}

// ── Lanes ──

/** One row of a lane on the page: one of the user's landed PRs, or a teammate's queue entry. */
export interface PageRow {
    readonly key: string;
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly lane: LaneKind;
    readonly stage: LaneStage;
    /** What every place says of the stage (#441). */
    readonly words: StageWords;
    /** What the row's number column says: its place in the lane, or null for "·". */
    readonly order: number | null;
    /** The user's own landed PR; null on a teammate's row. */
    readonly landed: LandedView | null;
    /** A teammate's queue entry; null on the user's own. */
    readonly teammate: TeammateEntry | null;
}

export interface PageLane {
    readonly repository: string;
    readonly kind: LaneKind;
    /** Updating the head loses its approval here (Switchboard lanes only). */
    readonly approvalLostOnPush: boolean;
    /** The head first, then as the lane orders them; merged PRs are left out. */
    readonly rows: readonly PageRow[];
}

/** Every lane with something of the user's still in it, by repository. */
export function pageLanes(state: MergeManagerState): PageLane[] {
    return state.lanes
        .map(pageLane)
        .filter((lane) => lane.rows.some((row) => row.landed !== null))
        .sort((a, b) => a.repository.localeCompare(b.repository));
}

function pageLane(lane: LaneView): PageLane {
    const base = (branch: string): string => {
        const under = lane.pullRequests.find((candidate) => candidate.headRef === branch);
        return under ? '#' + under.number : branch;
    };
    const own = lane.pullRequests.filter((pr) => pr.stage.kind !== 'merged');
    const theirs = lane.kind === 'queue' ? (lane.teammates ?? []) : [];
    const rows: Omit<PageRow, 'order'>[] = [
        ...own.map((pr) => ({
            key: pr.key,
            repository: lane.repository,
            number: pr.number,
            title: pr.title,
            url: pr.url,
            lane: lane.kind,
            stage: pr.stage,
            words: stageWords(pr.stage, pr.place, base),
            landed: pr,
            teammate: null,
            place: pr.place,
            landedAt: pr.landedAt,
        })),
        ...theirs.map((entry) => ({
            key: entry.key,
            repository: lane.repository,
            number: entry.number,
            title: entry.title,
            url: entry.url,
            lane: lane.kind,
            stage: entry.stage,
            words: stageWords(entry.stage, entry.place, base),
            landed: null,
            teammate: entry,
            place: entry.place,
            landedAt: Number.MAX_SAFE_INTEGER,
        })),
    ]
        .map((row, index) => ({row, index}))
        .sort((a, b) => rank(a.row, lane.kind) - rank(b.row, lane.kind) || within(a, b, lane.kind))
        .map(({row}) => strip(row));
    return {
        repository: lane.repository,
        kind: lane.kind,
        approvalLostOnPush: lane.approvalLostOnPush,
        rows: rows.map((row, index) => ({
            ...row,
            order: lane.kind === 'switchboard' ? index + 1 : placeOf(row),
        })),
    };
}

type Sortable = Omit<PageRow, 'order'> & {place: number | null; landedAt: number};

/** The head first; in a queue lane the queued ones by their number next; then the rest. */
function rank(row: Sortable, kind: LaneKind): number {
    if (row.stage.kind === 'head') return 0;
    if (kind === 'queue' && row.stage.kind === 'waiting' && row.place !== null) return 1;
    return 2;
}

function within(a: {row: Sortable; index: number}, b: {row: Sortable; index: number}, kind: LaneKind): number {
    if (kind === 'queue' && a.row.place !== null && b.row.place !== null) return a.row.place - b.row.place;
    // Land order: the user's own come in it already; teammates' after them, by PR number.
    return a.row.landedAt - b.row.landedAt || a.index - b.index || a.row.number - b.row.number;
}

function strip({place: _place, landedAt: _landedAt, ...row}: Sortable): Omit<PageRow, 'order'> {
    return row;
}

function placeOf(row: Omit<PageRow, 'order'>): number | null {
    if (row.stage.kind === 'head') return 1;
    return row.landed?.place ?? row.teammate?.place ?? null;
}

/** The keys of every row J/K moves over, top to bottom. */
export function rowKeys(lanes: readonly PageLane[]): string[] {
    return lanes.flatMap((lane) => lane.rows.map((row) => row.key));
}

/** The row with `key`; null when it is not on the page. */
export function findRow(lanes: readonly PageLane[], key: string | null): PageRow | null {
    if (!key) return null;
    for (const lane of lanes) {
        const row = lane.rows.find((candidate) => candidate.key === key);
        if (row) return row;
    }
    return null;
}

/** The selected row: the one with `key` while it is on the page, else the first; null on an empty page. */
export function selectedRow(lanes: readonly PageLane[], key: string | null): PageRow | null {
    return findRow(lanes, key) ?? lanes[0]?.rows[0] ?? null;
}

// ── What a row offers ──

export interface RowActions {
    /** ⏎: the PR's own session, or the fix errand's; null for a teammate's row. */
    readonly open: {readonly kind: 'session'} | {readonly kind: 'errand'; readonly sessionId: string} | null;
    /** T: Try again, for any Needs you: a new fix errand once one gave up, else back to its place. */
    readonly tryAgain: boolean;
    /** N: the reviewer it waits on, who can be nudged (a user, not a team); null otherwise. */
    readonly nudge: string | null;
    /** U: take it out of its lane. */
    readonly unland: boolean;
}

export function rowActions(row: PageRow): RowActions {
    const {stage} = row;
    const nudge =
        stage.kind === 'held' && stage.reason.kind === 'review' && !stage.reason.team ? stage.reason.reviewer : null;
    if (!row.landed) return {open: null, tryAgain: false, nudge, unland: false};
    const errand = row.landed.errand;
    const stopped = stage.kind === 'needsYou' && stage.reason.kind === 'errand-stopped';
    const open: RowActions['open'] =
        errand && (stage.kind === 'fixing' || stopped) ? {kind: 'errand', sessionId: errand} : {kind: 'session'};
    // Try again clears Needs you for any reason (#432 story 14).
    return {open, tryAgain: stage.kind === 'needsYou', nudge, unland: stage.kind !== 'merged'};
}

/** The errand working on a PR, or that last did: the newest the facts know of. */
export function errandOf(facts: MergeManagerPageFacts | null, key: string): ErrandView | null {
    const own = (facts?.errands ?? []).filter((errand) => errand.key === key);
    return own.length > 0 ? own[own.length - 1] : null;
}

/** The earlier errands' notes for a PR, oldest first. */
export function errandNotes(facts: MergeManagerPageFacts | null, key: string): ErrandView[] {
    return (facts?.errands ?? []).filter((errand) => errand.key === key && errand.note);
}

// ── Words ──

/** "Switchboard lane" or "Queue lane". */
export function laneKindLabel(kind: LaneKind): string {
    return kind === 'switchboard' ? 'Switchboard lane' : 'Queue lane';
}

/** The page's subline: "2 Switchboard lanes, 1 queue lane · 5 landed". */
export function pageSubline(lanes: readonly PageLane[]): string {
    const switchboard = lanes.filter((lane) => lane.kind === 'switchboard').length;
    const queue = lanes.length - switchboard;
    const landed = lanes.reduce((sum, lane) => sum + lane.rows.filter((row) => row.landed).length, 0);
    const kinds = [
        switchboard > 0 ? plural(switchboard, 'Switchboard lane', 'Switchboard lanes') : null,
        queue > 0 ? plural(queue, 'queue lane', 'queue lanes') : null,
    ].filter((part): part is string => part !== null);
    return kinds.length === 0 ? 'Nothing landed' : `${kinds.join(', ')} · ${landed} landed`;
}

/** The row's stage pill: the head says its step ("Head · checks"), a teammate's head "Head · not yours". */
export function rowStageLabel(row: PageRow): string {
    if (row.stage.kind === 'head') return row.teammate ? 'Head · not yours' : 'Head · ' + row.stage.step;
    if (row.stage.kind === 'waiting') return 'Waiting';
    return row.words.label;
}

/** The head card's three steps, with "Checks n of m" once the checks are known. */
export function headSteps(row: PageRow): {label: string; state: 'done' | 'active' | 'todo'; progress: number}[] {
    if (row.stage.kind !== 'head') return [];
    const at = row.stage.step === 'updating' ? 0 : row.stage.step === 'checks' ? 1 : 2;
    const checks = row.landed?.facts?.checks ?? [];
    const passed = checks.filter((check) => check.state === 'passed' || check.state === 'skipped').length;
    const checkLabel = row.teammate
        ? 'Checks (the queue)'
        : checks.length > 0
          ? `Checks ${passed} of ${checks.length}`
          : 'Checks';
    const checkProgress = at > 1 ? 1 : at === 1 && checks.length > 0 ? passed / checks.length : 0;
    return [row.teammate ? 'Rebased' : 'Updated on the trunk', checkLabel, 'Merge'].map((label, index) => ({
        label,
        state: index < at ? 'done' : index === at ? 'active' : 'todo',
        progress: index === 1 ? checkProgress : index < at ? 1 : 0,
    }));
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}
