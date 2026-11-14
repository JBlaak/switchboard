/**
 * Where an item being worked on stands (#414, for #409), from its session and
 * the PR of the branch its Fix or Start made: the pill its row shows, or the
 * end of the work.
 *
 * - **Working**: the session runs and there is no PR yet.
 * - **Needs you**: the session waits on you (a question, a permission).
 * - **PR · CI**: the PR is open and its checks run.
 * - **CI failing**: a check failed.
 * - **Ready**: checks passed (or there are none).
 * - **Queue · n**: the PR is in the merge queue, `n`th.
 * - **Merged**: the PR merged; the item is done.
 *
 * A session that ended without a PR (none was opened, or the one it opened
 * was closed unmerged) ends the work: the item goes back to the inbox, read,
 * marked "Tried, no PR".
 */
import {INBOX_STAGE_LABELS, ordinal} from '../merge-manager/stage-words';
import type {InboxStage} from './model';

/** What the session is doing, as far as the stage goes. */
export type WorkSession = 'running' | 'needsYou' | 'ended';

/** The branch's PR, as far as the stage goes. */
export interface WorkPullRequest {
    readonly state: 'open' | 'draft' | 'merged' | 'closed';
    /** Its checks together: none at all, any still running, all passed, or any failed. */
    readonly checks: 'none' | 'pending' | 'passing' | 'failing';
    /** Its place in the merge queue, from 1; null when it is not queued. */
    readonly queuePosition: number | null;
}

/** A branch's PR as `gh` reads it for the work on an item. */
export interface BranchPullRequest {
    readonly number: number;
    readonly url: string;
    readonly state: 'open' | 'draft' | 'merged' | 'closed';
    /** Its head commit's checks, skipped ones left out. */
    readonly checks: {
        readonly state: WorkPullRequest['checks'];
        readonly passed: number;
        readonly total: number;
        readonly failing: readonly string[];
    };
    /** ISO; null until it merged. */
    readonly mergedAt: string | null;
    readonly mergeCommit: string | null;
}

export type WorkProgress =
    {readonly kind: 'stage'; readonly stage: InboxStage} | {readonly kind: 'merged'} | {readonly kind: 'noPr'};

/** Where the work stands, from its session and its branch's PR (null before one is opened). */
export function workProgress(session: WorkSession, pr: WorkPullRequest | null): WorkProgress {
    if (pr?.state === 'merged') return {kind: 'merged'};
    const open = pr !== null && pr.state !== 'closed';
    if (!open) {
        if (session === 'ended') return {kind: 'noPr'};
        return stage(session === 'needsYou' ? 'needsYou' : 'working');
    }
    if (pr.queuePosition !== null) return stage('queue');
    if (session === 'needsYou') return stage('needsYou');
    if (pr.checks === 'failing') return stage('ciFailing');
    if (pr.checks === 'pending') return stage('prCi');
    return stage('ready');
}

function stage(stage: InboxStage): WorkProgress {
    return {kind: 'stage', stage};
}

/** The stages that want you: they put a peach dot on the In progress tab. */
export function wantsYou(stage: InboxStage): boolean {
    return stage === 'needsYou' || stage === 'ciFailing';
}

/**
 * A stage's pill text; `queuePosition` names the place for Queue. The words
 * are the one table the stage words keep (`INBOX_STAGE_LABELS`, #441).
 */
export function stageLabel(stage: InboxStage, queuePosition: number | null = null): string {
    const label = INBOX_STAGE_LABELS[stage];
    return stage === 'queue' && queuePosition ? `${label} · ${ordinal(queuePosition)}` : label;
}
