/**
 * What the project page's Merge queue section (#315) says, decided from the
 * overview's `mergeQueue` and the queue's errands: the heading's counts and
 * "Clears in about N min", the head's four steps, a failure in a few words,
 * and how far a Nudge or a Fix in session got.
 *
 * The queue itself is the domain's (`domain/project/merge-queue`); this only
 * words it. Pure, so it is tested in node.
 */
import type {FailureKind, HeadStage, MergeQueue, QueueEntry, QueuedEntry} from '../../../domain/project/merge-queue';
import type {QueueErrandView} from '../../../domain/project/queue-errands';
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

/** Rebased on the trunk → Pushed → Required checks done of total → Merge, from where the head is. */
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
                  `Required checks ${stage.done} of ${stage.total}`,
                  stage.running ?? (stage.waitsForCiOn !== null ? `waits for CI on #${stage.waitsForCiOn}` : null),
                  stage.total ? stage.done / stage.total : 0,
              )
            : step(2, 'Required checks');
    return [step(0, 'Rebased on the trunk'), step(1, 'Pushed'), checks, step(3, 'Merge')];
}

/** "approved by ana, sam"; null when nobody has. */
export function approvedText(entry: QueueEntry): string | null {
    return entry.approvedBy.length ? 'approved by ' + entry.approvedBy.join(', ') : null;
}

/**
 * Who a held entry's Nudge would go to: the user it waits on for a review.
 * Null for one that is queued, waits for any approval, or waits on a team,
 * which nobody can be nudged as.
 */
export function reviewerOf(entry: QueuedEntry): string | null {
    const {state} = entry;
    return state.kind === 'held' && state.waitsFor.kind === 'review' && !state.waitsFor.team
        ? state.waitsFor.reviewer
        : null;
}

/**
 * The PR a held entry's Nudge is about: the stack member the review is asked
 * on, when the queue named one, else the entry's own PR.
 */
export function nudgePullRequest(entry: QueuedEntry): {number: number; title: string; url: string} {
    const member = entry.state.kind === 'held' ? entry.state.member : null;
    const pr = entry.members.find((candidate) => candidate.number === member) ?? entry;
    return {number: pr.number, title: pr.title, url: pr.url};
}

/** The held entries waiting for a review (by the PR a nudge is about), for `queueSettleNudges`. */
export function heldForReview(queue: MergeQueue): {number: number; reviewer: string}[] {
    return queue.entries.flatMap((entry) => {
        const reviewer = reviewerOf(entry);
        return reviewer ? [{number: nudgePullRequest(entry).number, reviewer}] : [];
    });
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
