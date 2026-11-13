/**
 * What the project page's Merge queue section (#315) says, decided from the
 * overview's `mergeQueue` and the queue's errands: the heading's counts and
 * "Clears in about N min", the head's four steps, a failure in a few words,
 * and how far a Nudge or a Fix in session got.
 *
 * The queue itself is the domain's (`domain/project/merge-queue`); this only
 * words it. Pure, so it is tested in node.
 */
import {
    expectedMinutes,
    MIN_ESTIMATE_MS,
    QUEUE_STEP_MS,
    type FailureKind,
    type HeadStage,
    type MergeQueue,
    type QueueEntry,
} from '../../../domain/project/merge-queue';
import {expectedWaitMs, jobOn, type JobPool, type JobQueueRow} from '../../../domain/project/ci-job-queue';
import type {QueueErrandView} from '../../../domain/project/queue-errands';
import type {ProjectPageState} from '../../state/project-page-slice';
import type {
    HeadStep as LaneHeadStep,
    LandedView,
    LaneView,
    MergeManagerState,
} from '../../../domain/merge-manager/model';

/** The overview's merge queue for `projectPath`; null while there is none to show (no answer, no queue). */
export function mergeQueueOf(page: ProjectPageState, projectPath: string): MergeQueue | null {
    const github = page.overview?.projectPath === projectPath ? page.overview.github : null;
    return github?.ok ? (github.mergeQueue ?? null) : null;
}

/** Whole minutes, never under one: "0 min" reads as broken. */
export function minutesOf(ms: number): number {
    return Math.max(1, Math.round(ms / 60_000));
}

/** "~6 min", or null without an estimate. */
export function estimateText(ms: number | null): string | null {
    return ms === null ? null : '~' + minutesOf(ms) + ' min';
}

/** An expected merge time as it reads at its place: "~6 min", or rough ("~25 min", faded) from place 3 on. */
export interface ExpectedText {
    readonly text: string;
    readonly rough: boolean;
}

/** The expected merge time of the entry at `place` (the head is 1); null without an estimate. */
export function expectedText(ms: number | null, place: number): ExpectedText | null {
    if (ms === null) return null;
    const {minutes, rough} = expectedMinutes(ms, place);
    return {text: '~' + minutes + ' min', rough};
}

/** What the heading says of a stalled queue. */
export const STALLED_TEXT = 'Stalled — nothing moves until a failed PR is fixed or retried';

/** The heading's counts: "4 queued · 1 held · 1 failed", leaving out the parts that are none. */
export function countsText(counts: MergeQueue['counts']): string {
    const parts: string[] = [];
    if (counts.queued) parts.push(counts.queued + ' queued');
    if (counts.held) parts.push(counts.held + ' held');
    if (counts.failed) parts.push(counts.failed + ' failed');
    return parts.join(' · ');
}

/** True when nothing is in the queue at all: no head, nothing behind it, nothing out of it. */
export function isEmptyQueue(queue: MergeQueue): boolean {
    return !queue.head && !queue.entries.length && !queue.failed.length && !queue.unknown.length;
}

/** One of the head's four steps. */
export interface HeadStep {
    readonly label: string;
    /** A second line: the check running now. */
    readonly detail: string | null;
    readonly state: 'done' | 'active' | 'todo';
    /** How much of the bar is filled, 0 to 1. */
    readonly progress: number;
}

/**
 * Rebased on the trunk → Pushed → Checks done of total → Merge, from where the
 * head is. Every check run counts, optional ones too, so it says Checks.
 */
export function headSteps(stage: HeadStage): HeadStep[] {
    const at = stage.kind === 'rebasing' ? 0 : stage.kind === 'checks' ? 2 : 3;
    const state = (index: number): HeadStep['state'] => (index < at ? 'done' : index === at ? 'active' : 'todo');
    const step = (index: number, label: string, detail: string | null = null, progress?: number): HeadStep => ({
        label,
        detail,
        state: state(index),
        progress: progress ?? (index < at ? 1 : 0),
    });
    const checks =
        stage.kind === 'checks'
            ? step(
                  2,
                  `Checks ${stage.done} of ${stage.total}`,
                  stage.running ?? (stage.waitsForCiOn !== null ? `waits for CI on #${stage.waitsForCiOn}` : null),
                  stage.total ? stage.done / stage.total : 0,
              )
            : step(2, 'Checks');
    return [step(0, 'Rebased on the trunk'), step(1, 'Pushed'), checks, step(3, 'Merge')];
}

/** "approved by ana, sam"; null when nobody has. */
export function approvedText(entry: QueueEntry): string | null {
    return entry.approvedBy.length ? 'approved by ' + entry.approvedBy.join(', ') : null;
}

/** A failure's kind in a few words, before the queue's own. */
export function failureLabel(kind: FailureKind): string {
    switch (kind) {
        case 'ci':
            return 'CI failed';
        case 'conflict':
            return 'Conflicts with the trunk';
        case 'changes-requested':
            return 'Changes requested';
        case 'unresolved-thread':
            return 'Unresolved thread';
        case 'merge-refused':
            return 'Merge refused';
        case 'other':
            return 'Failed';
    }
}

/**
 * Where a held entry's nudge of `reviewer` stands: none to show (Nudge is
 * offered), its session at work, stopped and needing you, or sent (Nudge
 * stays "Nudged" until the review request changes and main settles it).
 */
export type NudgeStatus =
    | {readonly kind: 'none'}
    | {readonly kind: 'running'; readonly sessionId: string | null}
    | {readonly kind: 'needs-you'; readonly sessionId: string | null}
    | {readonly kind: 'nudged'; readonly at: number};

/** The latest standing nudge of `reviewer` on PR `number`, among `errands`. */
export function nudgeStatus(errands: readonly QueueErrandView[], number: number, reviewer: string): NudgeStatus {
    const errand = [...errands]
        .reverse()
        .find(
            (candidate) =>
                candidate.kind === 'nudge' &&
                candidate.number === number &&
                candidate.reviewer === reviewer &&
                candidate.settledAt === null,
        );
    if (!errand) return {kind: 'none'};
    switch (errand.state) {
        case 'starting':
        case 'running':
            return {kind: 'running', sessionId: errand.sessionId};
        case 'needs-you':
            return {kind: 'needs-you', sessionId: errand.sessionId};
        case 'done':
            return {kind: 'nudged', at: errand.createdAt};
    }
}

/** Where a failed entry's fix stands: none (Fix in session is offered), at work, or stopped and needing you. */
export type FixStatus =
    | {readonly kind: 'none'}
    | {readonly kind: 'running'; readonly sessionId: string | null}
    | {readonly kind: 'needs-you'; readonly sessionId: string | null};

/** The latest fix errand still going for any of `numbers` (a stack's members), among `errands`. */
export function fixStatus(errands: readonly QueueErrandView[], numbers: readonly number[]): FixStatus {
    const errand = [...errands]
        .reverse()
        .find((candidate) => candidate.kind === 'fix' && numbers.includes(candidate.number));
    if (!errand || errand.state === 'done') return {kind: 'none'};
    return errand.state === 'needs-you'
        ? {kind: 'needs-you', sessionId: errand.sessionId}
        : {kind: 'running', sessionId: errand.sessionId};
}

/** "14:52", in local time. */
export function clockTime(at: number): string {
    const date = new Date(at);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

// ── The CI job queue ──

/** "2 of 3 runners busy", or that none of its runners can be read. */
export function poolBusyText(pool: JobPool): string {
    if (pool.runners.length === 0) return 'no online runner fits';
    const busy = pool.runners.filter((runner) => runner.busy).length;
    return `${busy} of ${pool.runners.length} runner${pool.runners.length === 1 ? '' : 's'} busy`;
}

/** "~6 min" from now until `at`, "~6+ min" when it is the earliest it can be. */
function aboutText(at: number, now: number, lowerBound: boolean): string {
    const minutes = Math.max(1, Math.round((at - now) / 60_000));
    return '~' + minutes + (lowerBound ? '+' : '') + ' min';
}

/** One row of a runner pool, worded. */
export interface JobRowView {
    /** "Tests (CI)", or the runner a row of another repository's job is about. */
    readonly title: string;
    /** "#12 Title", or a branch; null for another repository's job. */
    readonly on: string | null;
    /** The runner it runs on, or the labels it waits for. */
    readonly where: string;
    /** Its runner wait: so far while queued, and how long it waited once running. */
    readonly wait: string | null;
    /** "starts ~6 min · done ~30 min", "done ~4 min", or null when nobody can tell. */
    readonly times: string | null;
}

export function jobRowView(row: JobQueueRow, now: number): JobRowView {
    if (row.kind === 'other') {
        return {
            title: row.runner,
            on: null,
            where: 'busy (other repository)',
            wait: null,
            times: row.endsAt === null ? null : 'free ' + aboutText(row.endsAt, now, row.lowerBound),
        };
    }
    const {job} = row;
    const queued = job.status === 'queued';
    const waited = Math.max(0, (queued ? now : (job.startedAt ?? now)) - job.createdAt);
    const wait = queued ? `waiting ${minutesOf(waited)} min` : `waited ${minutesOf(waited)} min`;
    const starts = expectedWaitMs(row, now);
    const parts = [
        starts === null ? null : 'starts ' + aboutText(now + starts, now, row.lowerBound),
        row.endsAt === null ? null : 'done ' + aboutText(row.endsAt, now, row.lowerBound),
    ].filter((part): part is string => part !== null);
    const labels = job.labels.filter((label) => label.toLowerCase() !== 'self-hosted').join(' · ');
    return {
        title: `${job.name} (${job.workflow})`,
        on: jobOn(job),
        where: job.runner ?? (labels ? 'waits for ' + labels : 'waits for a runner'),
        wait,
        times: parts.length ? parts.join(' · ') : null,
    };
}

// ── A Switchboard lane (#441) ──

/**
 * A Switchboard lane as the Merge queue section shows it: the lane's landed
 * PRs that have not merged, head first, then in land order.
 */
export interface SwitchboardLaneSection {
    readonly repository: string;
    readonly lane: LaneView;
    readonly rows: readonly LandedView[];
    /** One CI run, the median of the green ones; null with too few. */
    readonly runMs: number | null;
}

/**
 * The Switchboard lane the page's repository merges through, once anything
 * in it is landed; null for a queue lane (it has its own section), a
 * repository whose lane is not known yet, or a lane with nothing landed.
 */
export function switchboardLaneOf(
    page: ProjectPageState,
    projectPath: string,
    merge: MergeManagerState,
): SwitchboardLaneSection | null {
    const overview = page.overview?.projectPath === projectPath ? page.overview : null;
    const github = overview?.github;
    if (!overview?.repository || !github?.ok || !github.switchboardLane || github.mergeQueue) return null;
    const repository = overview.repository.toLowerCase();
    const lane = merge.lanes.find(
        (candidate) => candidate.kind === 'switchboard' && candidate.repository.toLowerCase() === repository,
    );
    const rows = lane ? laneRows(lane) : [];
    if (!lane || rows.length === 0) return null;
    return {repository: overview.repository, lane, rows, runMs: github.switchboardLane.runMs};
}

/** The rows of a lane: the head, then those with a place, then the rest in land order; merged ones left out. */
export function laneRows(lane: LaneView): LandedView[] {
    const open = lane.pullRequests.filter((pr) => pr.stage.kind !== 'merged');
    const placed = open.filter((pr) => pr.place !== null).sort((a, b) => a.place! - b.place!);
    return [...placed, ...open.filter((pr) => pr.place === null)];
}

/** The heading's counts: "1 head · 1 waiting · 2 held", leaving out the parts that are none. */
export function laneCountsText(rows: readonly LandedView[]): string {
    const count = (kind: LandedView['stage']['kind']): number => rows.filter((pr) => pr.stage.kind === kind).length;
    const parts: [number, string][] = [
        [count('head'), 'head'],
        [count('waiting'), 'waiting'],
        [count('held'), 'held'],
        [count('fixing'), 'fixing'],
        [count('needsYou'), 'need you'],
    ];
    return parts
        .filter(([n]) => n > 0)
        .map(([n, word]) => (word === 'need you' && n === 1 ? '1 needs you' : `${n} ${word}`))
        .join(' · ');
}

/**
 * How long until each PR with a place merges, by place: the head what is left
 * of it (a whole run and a step while it is updated, half a run while its
 * checks run, a minute once it merges), and every PR waiting behind it one
 * more run and one step. Empty without a run time to go by.
 */
export function laneEstimates(rows: readonly LandedView[], runMs: number | null): Map<number, number> {
    const out = new Map<number, number>();
    if (runMs === null) return out;
    let at = 0;
    for (const pr of rows) {
        if (pr.place === null) continue;
        if (pr.stage.kind === 'head') {
            at =
                pr.stage.step === 'updating'
                    ? runMs + QUEUE_STEP_MS
                    : pr.stage.step === 'checks'
                      ? runMs / 2
                      : MIN_ESTIMATE_MS;
        } else at += runMs + QUEUE_STEP_MS;
        out.set(pr.place, Math.max(MIN_ESTIMATE_MS, at));
    }
    return out;
}

/** Updated on the trunk → Checks → Merge, from where a Switchboard lane's head is. */
export function laneHeadSteps(step: LaneHeadStep): HeadStep[] {
    const at = step === 'updating' ? 0 : step === 'checks' ? 1 : 2;
    return ['Updated on the trunk', 'Checks', 'Merge'].map((label, index) => ({
        label,
        detail: null,
        state: index < at ? 'done' : index === at ? 'active' : 'todo',
        progress: index < at ? 1 : 0,
    }));
}
