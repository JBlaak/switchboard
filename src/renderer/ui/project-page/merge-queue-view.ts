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
    type FailureKind,
    type HeadStage,
    type MergeQueue,
    type QueueEntry,
} from '../../../domain/project/merge-queue';
import {expectedWaitMs, jobOn, type JobPool, type JobQueueRow} from '../../../domain/project/ci-job-queue';
import type {QueueErrandView} from '../../../domain/project/queue-errands';
import type {MergeManagerState} from '../../../domain/merge-manager/model';
import type {ProjectPageState} from '../../state/project-page-slice';

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

/**
 * Where a failed entry stands when the PR is landed (#437): the Merge
 * manager's fix errand has it, so Fix in session and Retry give way to it.
 * `fixing` while an errand works on it (or is about to start), `needs-you`
 * once one gave up (Open and Try again). Null when none of `numbers` is
 * landed, or when what stops it is not an errand's to fix.
 */
export type LandedFixStatus =
    | {readonly kind: 'fixing'; readonly number: number; readonly sessionId: string | null}
    | {readonly kind: 'needs-you'; readonly number: number; readonly sessionId: string | null};

export function landedFixStatus(
    state: MergeManagerState,
    repository: string,
    numbers: readonly number[],
): LandedFixStatus | null {
    const lane = state.lanes.find((candidate) => candidate.repository.toLowerCase() === repository.toLowerCase());
    for (const pr of lane?.pullRequests ?? []) {
        if (!numbers.includes(pr.number)) continue;
        if (pr.stage.kind === 'fixing') return {kind: 'fixing', number: pr.number, sessionId: pr.errand};
        if (pr.stage.kind === 'needsYou' && pr.stage.reason.kind === 'errand-stopped') {
            return {kind: 'needs-you', number: pr.number, sessionId: pr.errand};
        }
    }
    return null;
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
