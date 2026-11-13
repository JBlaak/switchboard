/**
 * The Merge manager (#434, for #432): what a landed pull request is, the lane
 * it waits in and the stage it is at, and what a poll reads of it.
 *
 * Only the user's own open, non-draft PRs are landed. A repository has one
 * lane, of one of two kinds (`GLOSSARY.md`):
 *
 * - a **queue lane**, run by the merge-queue Action, which Switchboard reads
 *   and steers through the queue's labels only;
 * - a **Switchboard lane**, which Switchboard runs itself by the same rule:
 *   only the head is brought up to date, tested and merged.
 *
 * Both lanes map onto one stage model (#423): Waiting · Held · Head (updating,
 * checks, merging) · Fixing · Needs you · Merged. Land order is the time a PR
 * was landed; Fixing and Needs you keep it, so a PR goes back to its old place.
 *
 * Times are epoch ms.
 */
import type {AutomergeStatus, QueueCheckRun} from '../project/merge-queue';
import type {ReviewDecision} from '../project/overview';

export type LaneKind = 'queue' | 'switchboard';

/** Why a landed PR is passed over while it keeps its place. */
export type HeldReason =
    | {readonly kind: 'approval'}
    /** A requested review is outstanding; `team` when it is asked of a team (`org/slug`). */
    | {readonly kind: 'review'; readonly reviewer: string; readonly team: boolean}
    /** Stacked on a branch that has not merged yet. */
    | {readonly kind: 'base'; readonly base: string}
    /** Turned back into a draft after it was landed. */
    | {readonly kind: 'draft'};

/** What only the PR's author can settle. */
export type NeedsYouReason =
    | {readonly kind: 'changes-requested'}
    | {readonly kind: 'unresolved-thread'}
    /** A fix errand stopped without pushing a fix or judging the failure flaky. */
    | {readonly kind: 'errand-stopped'}
    /** GitHub refused the merge, or the queue failed it, for a reason nothing here can fix. */
    | {readonly kind: 'merge-refused'; readonly reason: string};

/** What a fix errand works on. */
export type FixingCause = 'conflict' | 'checks';

/** The head's way through: brought up to date, its checks, its merge. */
export type HeadStep = 'updating' | 'checks' | 'merging';

export type LaneStage =
    /** `position` is the queue's own number in a queue lane; null in a Switchboard lane, whose place is its land order. */
    | {readonly kind: 'waiting'; readonly willConflict: boolean; readonly position: number | null}
    | {readonly kind: 'held'; readonly reason: HeldReason}
    | {readonly kind: 'head'; readonly step: HeadStep}
    | {readonly kind: 'fixing'; readonly cause: FixingCause}
    | {readonly kind: 'needsYou'; readonly reason: NeedsYouReason}
    | {readonly kind: 'merged'; readonly at: number};

export type LaneStageKind = LaneStage['kind'];

/**
 * A PR set aside by the lane runner or a fix errand (#435, #437): Fixing
 * while an errand works on a head that failed out, Needs you once one gave
 * up. It holds for the commit it was set on: a new head commit (the errand's
 * push, the author's) clears it, and the PR goes back to its place.
 */
export interface SetAside {
    readonly kind: 'fixing' | 'needsYou';
    readonly cause: FixingCause | null;
    readonly reason: NeedsYouReason | null;
    /** The head commit it was set on. */
    readonly headOid: string;
}

/** A landed PR, as the Merge manager keeps it. */
export interface LandedPullRequest {
    /** `owner/repo#n` (`landedKey`). */
    readonly key: string;
    /** `owner/repo`. */
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly headRef: string;
    readonly lane: LaneKind;
    readonly landedAt: number;
    readonly stage: LaneStage;
    readonly setAside: SetAside | null;
    /** The session of the fix errand working on it, or that last did; null without one. */
    readonly errand: string | null;
    /**
     * The last tip seen of the branch it is stacked on, while it was: once that
     * merged, a fix errand rebases with `--onto` past its commits (#437).
     */
    readonly stackBaseTip?: string;
}

export function landedKey(repository: string, number: number): string {
    return `${repository.toLowerCase()}#${number}`;
}

// ── What a poll reads ──

/** A check on the PR's head commit: a check run, or a commit status other than the queue's own. */
export type LaneCheck = QueueCheckRun;

/** One PR as the lane read sees it. */
export interface LanePullRequestRead {
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    /** The author's login; null for a deleted account. */
    readonly author: string | null;
    readonly state: 'open' | 'closed' | 'merged';
    /** ISO; null while it has not merged. */
    readonly mergedAt: string | null;
    readonly draft: boolean;
    readonly headRef: string;
    readonly headOid: string;
    readonly baseRef: string;
    /** The base branch's tip; absent when GitHub did not say. */
    readonly baseOid?: string;
    readonly labels: readonly string[];
    /** The queue's `automerge` status on the head commit; null without one. */
    readonly automerge: AutomergeStatus | null;
    readonly review: ReviewDecision;
    /** Logins that approved it. */
    readonly approvedBy: readonly string[];
    /** Users (`login`) and teams (`org/slug`) a review is still requested from. */
    readonly requestedReviewers: readonly string[];
    readonly unresolvedThreads: number;
    /** GitHub's `mergeStateStatus`, lower case: `clean`, `behind`, `dirty`, `blocked`, `unstable`, `unknown`, … */
    readonly mergeState: string;
    readonly checks: readonly LaneCheck[];
}

/** What a repository's trunk rules say, as far as the lane needs them. */
export interface TrunkRules {
    /** The contexts every PR needs green to merge, from every active ruleset. */
    readonly requiredChecks: readonly string[];
    /**
     * A push to a PR dismisses its approval, or needs a new one by someone
     * else (`dismissStaleReviewsOnPush`, `requireLastPushApproval`): updating
     * the head loses its approval, so the lane would keep holding it.
     */
    readonly approvalLostOnPush: boolean;
}

/** One repository's lane read: its trunk, its rules, and the PRs asked for. */
export interface LaneRead {
    readonly repository: string;
    /** The user `gh` signs in as. */
    readonly viewer: string;
    readonly trunk: string;
    readonly trunkOid: string;
    readonly rules: TrunkRules;
    /** The PRs asked for that GitHub knows. */
    readonly pullRequests: readonly LanePullRequestRead[];
}

/** A file in `.github/workflows` on the default branch. */
export interface WorkflowFile {
    readonly name: string;
    readonly text: string;
}

// ── What the renderer is shown ──

/** A landed PR with its place: 1 for the head, then the waiting ones; null for the rest. */
export interface LandedView extends LandedPullRequest {
    readonly place: number | null;
}

export interface LaneView {
    readonly repository: string;
    readonly kind: LaneKind;
    /** Updating the head loses its approval in this repository (Switchboard lanes only). */
    readonly approvalLostOnPush: boolean;
    /** In land order, merged ones last. */
    readonly pullRequests: readonly LandedView[];
}

/** Every lane with a landed PR, and how many PRs need you. */
export interface MergeManagerState {
    readonly lanes: readonly LaneView[];
    readonly needsYou: number;
}

export const EMPTY_MERGE_MANAGER_STATE: MergeManagerState = {lanes: [], needsYou: 0};
