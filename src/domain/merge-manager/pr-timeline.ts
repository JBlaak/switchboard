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
 * | Needs you: changes / thread       | Review `stopped`, In line `held` ("keeps 2nd")        |
 * | Needs you: errand stopped/refused | Head `stopped` (the head step it failed on `stopped`) |
 * | Held: approval / review           | Review `held`, In line `held`                         |
 * | Held: base / draft                | In line `held`                                        |
 * | Waiting                           | In line `now` (`conflict` when it will conflict)      |
 * | Head                              | Head `now`, its step `now`                            |
 * | Fixing                            | Head `fixing`, the step it mends `fixing`             |
 * | Not landed: draft                 | Opened `now`                                          |
 * | Not landed: in review / none      | Review `todo` ("@ana" / "nobody asked")               |
 * | Not landed: changes asked         | Review `stopped`                                      |
 * | Not landed: checks running        | Checks `now`                                          |
 * | Not landed: checks failing        | Checks `stopped`                                      |
 * | Not landed: conflicts             | Landed `conflict`                                     |
 * | Not landed: ready                 | Landed `now` (the next move is Land it)               |
 *
 * A landed PR is always landed: for a landed one everything before the mark
 * is `done` unless the table says otherwise, everything after it `todo`. A
 * not landed one's Review and Checks say how they stand (approved `done`,
 * changes asked `stopped`, not given yet `todo`; checks green `done`, failing
 * `stopped`, running `now` only while that is all it waits on, else `todo`),
 * Opened is `done`, and Landed onward `todo` unless the table marks Landed.
 * At most one station is `now`.
 *
 * Pure; times are epoch ms.
 */
import {MIN_ESTIMATE_MS, QUEUE_STEP_MS} from '../project/merge-queue';
import type {BarTiming} from './progress';
import {notLandedStatus, type OpenPullRequest} from './not-landed';
import type {PageRow} from './page';
import {ordinal} from './stage-words';
import {checksSince, durationText, untilText, type RowTime} from './times';

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
export function landedTimeline(row: PageRow, time: RowTime | undefined, runMs: number | null, now: number): PrTimeline {
    const {stage, landed} = row;
    const marks = landedMarks(row);
    const approver = landed.facts?.approvedBy[0];
    const subs: Partial<Record<StationId, string>> = {landed: clock(landed.landedAt)};
    if (approver) subs.review = '@' + approver;
    if (stage.kind === 'held' && stage.reason.kind === 'review') subs.review = '@' + stage.reason.reviewer;
    if (stage.kind === 'held' && stage.reason.kind === 'base') subs.line = row.words.pill.replace(/^held · /, '');
    const place = stage.kind === 'waiting' ? (stage.position ?? landed.place) : null;
    if (place !== null) subs.line = ordinal(place);
    if (marks.review === 'stopped' && row.order !== null) subs.line = 'keeps ' + ordinal(row.order);
    if (time) subs.merged = (time.rough ? '≈' : '~') + clock(time.at);

    const durations: Partial<Record<StationId, string>> = {};
    if (stage.kind === 'waiting') durations.line = durationText(Math.max(0, now - landed.landedAt));
    if (stage.kind === 'head') {
        const since = checksSince(landed);
        if (since !== null && since > landed.landedAt) durations.line = durationText(since - landed.landedAt);
    }

    const parts = headPartsOf(row);
    return {
        stations: stationsOf(marks, subs, durations),
        headParts: parts,
        live: headLive(row, parts, runMs),
        now: landedNow(row, time, place),
        label: labelOf(marks),
    };
}

/** A not landed PR's timeline: Landed and after are still to come. */
export function notLandedTimeline(pr: OpenPullRequest, now: number): PrTimeline {
    void now;
    const status = notLandedStatus(pr);
    const {marks, subs} = notLandedStations(pr, status);
    return {
        stations: stationsOf(marks, subs, {}),
        headParts: null,
        live:
            status === 'checksRunning'
                ? {after: 'checks', timing: {actual: null, startedAt: null, expectedMs: null}}
                : null,
        now: notLandedNow(pr, status),
        label: labelOf(marks),
    };
}

// ── Marks ──

type Marks = Record<StationId, StationMark>;

/** `mark` on `at`, everything before it done and everything after it to come. */
function marked(at: StationId, mark: StationMark): Marks {
    const index = STATION_IDS.indexOf(at);
    return Object.fromEntries(
        STATION_IDS.map((id, i) => [id, i < index ? 'done' : i === index ? mark : 'todo']),
    ) as Marks;
}

function landedMarks(row: PageRow): Marks {
    const {stage} = row;
    switch (stage.kind) {
        case 'needsYou':
            return stage.reason.kind === 'changes-requested' || stage.reason.kind === 'unresolved-thread'
                ? {...marked('line', 'held'), review: 'stopped'}
                : marked('head', 'stopped');
        case 'held':
            return stage.reason.kind === 'approval' || stage.reason.kind === 'review'
                ? {...marked('line', 'held'), review: 'held'}
                : marked('line', 'held');
        case 'waiting':
            return marked('line', stage.willConflict ? 'conflict' : 'now');
        case 'head':
            return marked('head', 'now');
        case 'fixing':
            return marked('head', 'fixing');
        case 'merged':
            return {...marked('merged', 'done')};
    }
}

/**
 * A not landed PR's stations as they stand: its review and its checks by what
 * GitHub says (at most one of them `now`), Landed by its status, the rest to come.
 */
function notLandedStations(
    pr: OpenPullRequest,
    status: ReturnType<typeof notLandedStatus>,
): {marks: Marks; subs: Partial<Record<StationId, string>>} {
    const marks = marked('landed', status === 'conflicts' ? 'conflict' : status === 'ready' ? 'now' : 'todo');
    const subs: Partial<Record<StationId, string>> = {opened: clock(pr.createdAt)};
    if (status === 'draft') marks.opened = 'now';

    if (pr.reviewDecision === 'APPROVED') {
        marks.review = 'done';
        if (pr.approvedBy[0]) subs.review = '@' + pr.approvedBy[0];
    } else if (pr.reviewDecision === 'CHANGES_REQUESTED') {
        marks.review = 'stopped';
        if (pr.changesRequestedBy[0]) subs.review = '@' + pr.changesRequestedBy[0];
    } else {
        marks.review = 'todo';
        subs.review = pr.reviewRequested[0] ? '@' + pr.reviewRequested[0] : 'nobody asked';
    }

    switch (pr.checks) {
        case 'success':
            marks.checks = 'done';
            subs.checks = 'green';
            break;
        case 'pending':
            marks.checks = status === 'checksRunning' ? 'now' : 'todo';
            subs.checks = 'running';
            break;
        case 'failure':
            marks.checks = 'stopped';
            subs.checks = 'failing';
            break;
        case null:
            marks.checks = 'todo';
            break;
    }
    return {marks, subs};
}

/** The stations, with their subs and durations where known. */
function stationsOf(
    marks: Marks,
    subs: Partial<Record<StationId, string>>,
    durations: Partial<Record<StationId, string>>,
): Station[] {
    return STATION_IDS.map((id) => ({
        id,
        label: STATION_LABELS[id],
        mark: marks[id],
        sub: subs[id] ?? null,
        duration: durations[id] ?? null,
    }));
}

const MARK_WORDS: Readonly<Record<StationMark, string>> = {
    done: 'done',
    now: 'now',
    stopped: 'stopped',
    conflict: 'conflict',
    fixing: 'being fixed',
    held: 'held',
    todo: 'to come',
};

function labelOf(marks: Marks): string {
    return STATION_IDS.map((id) => `${STATION_LABELS[id]} ${MARK_WORDS[marks[id]]}`).join(', ');
}

// ── The head ──

const HEAD_PARTS: readonly HeadPartId[] = ['update', 'checks', 'merge'];

/** Checks passed (or skipped) of all, while the last read knows them. */
function checksDone(row: PageRow): {passed: number; total: number} | null {
    const checks = row.landed.facts?.checks ?? [];
    if (checks.length === 0) return null;
    const passed = checks.filter((check) => check.state === 'passed' || check.state === 'skipped').length;
    return {passed, total: checks.length};
}

/** The part a head-bound stage marks, and how. */
function headMark(row: PageRow): {at: HeadPartId; mark: StationMark} | null {
    const {stage} = row;
    switch (stage.kind) {
        case 'head':
            return {
                at: stage.step === 'updating' ? 'update' : stage.step === 'checks' ? 'checks' : 'merge',
                mark: 'now',
            };
        case 'fixing':
            return {at: stage.cause === 'conflict' ? 'update' : 'checks', mark: 'fixing'};
        case 'needsYou':
            if (stage.reason.kind === 'errand-stopped') return {at: 'checks', mark: 'stopped'};
            if (stage.reason.kind === 'merge-refused') return {at: 'merge', mark: 'stopped'};
            return null;
        default:
            return null;
    }
}

function headPartsOf(row: PageRow): HeadPart[] | null {
    const at = headMark(row);
    if (!at) return null;
    const index = HEAD_PARTS.indexOf(at.at);
    const checks = checksDone(row);
    return HEAD_PARTS.map((id, i) => ({
        id,
        label: id === 'checks' && checks ? `checks ${checks.passed} of ${checks.total}` : id,
        mark: i < index ? 'done' : i === index ? at.mark : 'todo',
    }));
}

/** The head's active part, timed as the head card's bar is (`headSteps`). */
function headLive(row: PageRow, parts: readonly HeadPart[] | null, runMs: number | null): LiveStretch | null {
    if (row.stage.kind !== 'head' || !parts) return null;
    const active = parts.find((part) => part.mark === 'now');
    if (!active) return null;
    if (active.id === 'checks') {
        const checks = checksDone(row);
        return {
            after: 'checks',
            timing: {
                actual: checks ? checks.passed / checks.total : null,
                startedAt: checksSince(row.landed),
                expectedMs: runMs,
            },
        };
    }
    return {
        after: active.id,
        timing: {actual: null, startedAt: null, expectedMs: active.id === 'update' ? QUEUE_STEP_MS : MIN_ESTIMATE_MS},
    };
}

// ── Now ──

function landedNow(row: PageRow, time: RowTime | undefined, place: number | null): string {
    const {stage, words} = row;
    const merges = time ? 'merges ' + untilText(time) : null;
    switch (stage.kind) {
        case 'head': {
            if (stage.step === 'merging') return 'Merging now';
            if (stage.step === 'updating') return join('Being updated on the trunk at the head', merges);
            const checks = checksDone(row);
            return join(
                'Checks running on the head',
                checks ? `${checks.passed} of ${checks.total} done` : null,
                merges,
            );
        }
        case 'waiting':
            return join(
                place === null ? 'Waiting for its turn' : `Waiting ${ordinal(place)} in its lane`,
                stage.willConflict ? 'it will conflict with the trunk' : null,
                merges,
            );
        case 'held':
        case 'fixing':
            return join(words.title, 'keeps its place');
        case 'needsYou':
            return words.title;
        case 'merged':
            return 'Merged';
    }
}

function notLandedNow(pr: OpenPullRequest, status: ReturnType<typeof notLandedStatus>): string {
    const people = (logins: readonly string[]): string => logins.map((login) => '@' + login).join(', ');
    switch (status) {
        case 'ready':
            return 'Approved and green · land it to join its lane';
        case 'checksRunning':
            return join('Checks running', pr.approvedBy.length > 0 ? 'approved by ' + people(pr.approvedBy) : null);
        case 'checksFailing':
            return 'Its checks are failing';
        case 'conflicts':
            return 'Conflicts with its base';
        case 'changesAsked':
            return pr.changesRequestedBy.length > 0
                ? 'Changes asked by ' + people(pr.changesRequestedBy)
                : 'Changes asked';
        case 'inReview':
            return 'Review asked of ' + people(pr.reviewRequested);
        case 'noReview':
            return 'No review asked yet';
        case 'draft':
            return 'Draft';
    }
}

// ── Words ──

/** "09:05", local. */
function clock(at: number): string {
    const date = new Date(at);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

function join(...parts: (string | null)[]): string {
    return parts.filter((part): part is string => part !== null).join(' · ');
}
