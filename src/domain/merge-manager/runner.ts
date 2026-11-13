/**
 * The Switchboard lane runner's decisions (#435, for #432): what to do to a
 * Switchboard lane once a poll has placed its PRs (`stages.ts`), with as few
 * CI runs as possible.
 *
 * - **Only the head is updated**: rebased onto the trunk while it is behind,
 *   pinned to the head commit it was read at, at most once per commit
 *   (again only after `UPDATE_PATIENCE_MS`, should GitHub not have moved it).
 *   A head that is up to date but whose required check was cancelled has
 *   that run started again instead.
 * - **Green** is GitHub's `mergeStateStatus` saying it can merge (`clean`,
 *   `has_hooks`, or `unstable`: only a check that is not required failing)
 *   with every required context passed on that head commit.
 * - **The merge** is pinned to the green head commit, with the first method
 *   the repository's settings and its rules both allow: squash, else a merge
 *   commit (not under a linear history), else rebase.
 * - **Behind the head**, the unfinished runs of approved PRs that wait are
 *   cancelled; one still going `FORCE_CANCEL_AFTER_MS` later is
 *   force-cancelled. Nothing waiting is ever pushed. A PR a fix errand just
 *   ran again (`spared`) keeps its runs on that commit.
 * - **Will conflict**: GitHub's `dirty` on a waiting PR is confirmed by a test
 *   rebase once per head and trunk commit; it is only flagged.
 *
 * What the writes answer decides the next step (`afterUpdate`, `afterMerge`):
 * a 409 or a head that moved reads the lane again, a 405 updates the head
 * again, a conflict sets it aside as Fixing, and a refusal nothing here
 * understands puts it in Needs you. GitHub out of reach tries again next pass.
 */
import type {
    FixingCause,
    LandedPullRequest,
    LanePullRequestRead,
    MergeMethod,
    NeedsYouReason,
    TrunkRules,
} from './model';

/** How long an update is given to show up as a new head commit before it is asked for again. */
export const UPDATE_PATIENCE_MS = 10 * 60_000;

/** How long a cancelled run may keep going before it is force-cancelled. */
export const FORCE_CANCEL_AFTER_MS = 2 * 60_000;

/** The order merge methods are tried in. */
const METHOD_ORDER: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];

/** `mergeStateStatus` values GitHub merges at. */
const MERGEABLE_STATES = ['clean', 'has_hooks', 'unstable'];

/** A test rebase of a waiting PR onto the trunk, and the commits it was made at. */
export interface TestRebaseResult {
    readonly headOid: string;
    readonly trunkOid: string;
    readonly conflict: boolean;
    /** The files that conflict, when known. */
    readonly files: readonly string[];
}

/** What the runner remembers between passes. */
export interface RunnerMemory {
    /** The head commit an update was asked for, by PR key, and when. */
    readonly updated: ReadonlyMap<string, {readonly headOid: string; readonly at: number}>;
    /** Runs started again on a head. */
    readonly rerun: ReadonlySet<number>;
    /** Runs cancelled behind the head: when, and whether they were force-cancelled since. */
    readonly cancelled: ReadonlyMap<number, {readonly at: number; readonly forced: boolean}>;
    /** The last test rebase of each waiting PR, by key. */
    readonly testRebases: ReadonlyMap<string, TestRebaseResult>;
    /**
     * PRs a fix errand judged flaky and ran again (#437), by key: the head
     * commit it did so on. Their runs are left to finish behind the head, so
     * the errand's retry is not cancelled straight after.
     */
    readonly spared: ReadonlyMap<string, string>;
}

export const EMPTY_MEMORY: RunnerMemory = {
    updated: new Map(),
    rerun: new Set(),
    cancelled: new Map(),
    testRebases: new Map(),
    spared: new Map(),
};

/** One Switchboard lane after a poll placed it. */
export interface LaneInput {
    /** The lane's open landed PRs with what the poll read of each. */
    readonly entries: readonly {readonly landed: LandedPullRequest; readonly read: LanePullRequestRead}[];
    readonly trunkOid: string;
    readonly rules: TrunkRules;
    /** The merge methods the repository's settings allow. */
    readonly mergeMethods: readonly MergeMethod[];
    readonly now: number;
}

export type LaneAction =
    /** Rebase the head onto the trunk, pinned to `headOid`. */
    | {readonly kind: 'update'; readonly key: string; readonly pullRequestId: string; readonly headOid: string}
    /** Start the head's cancelled runs again. */
    | {readonly kind: 'rerun'; readonly key: string; readonly runIds: readonly number[]}
    /** Merge the green head at `sha`. */
    | {
          readonly kind: 'merge';
          readonly key: string;
          readonly number: number;
          readonly sha: string;
          readonly method: MergeMethod;
      }
    /** The head cannot merge for a reason nothing here can fix. */
    | {readonly kind: 'needsYou'; readonly key: string; readonly headOid: string; readonly reason: NeedsYouReason}
    /** Cancel an unfinished run of a PR waiting behind the head; `force` when cancelling did not stop it. */
    | {readonly kind: 'cancel'; readonly key: string; readonly runId: number; readonly force: boolean}
    /** Test-rebase a waiting PR onto the trunk to confirm GitHub's `dirty`. */
    | {readonly kind: 'testRebase'; readonly key: string; readonly branch: string; readonly headOid: string};

/** What to do to a Switchboard lane this pass: the head's step first, then behind it. */
export function laneActions(lane: LaneInput, memory: RunnerMemory): LaneAction[] {
    const actions: LaneAction[] = [];
    const head = lane.entries.find(({landed}) => landed.stage.kind === 'head');
    if (head) {
        const action = headAction(head.landed, head.read, lane, memory);
        if (action) actions.push(action);
    }

    for (const {landed, read} of lane.entries) {
        if (landed.stage.kind !== 'waiting') continue;
        // Only the head spends CI: what runs for a PR waiting behind it is stopped.
        if (head && memory.spared.get(landed.key) !== read.headOid) {
            for (const run of read.runs) {
                if (run.state !== 'unfinished') continue;
                const cancelled = memory.cancelled.get(run.id);
                if (!cancelled) actions.push({kind: 'cancel', key: landed.key, runId: run.id, force: false});
                else if (!cancelled.forced && lane.now - cancelled.at >= FORCE_CANCEL_AFTER_MS) {
                    actions.push({kind: 'cancel', key: landed.key, runId: run.id, force: true});
                }
            }
        }
        if (read.mergeState === 'dirty' && !testRebaseFor(memory, landed.key, read.headOid, lane.trunkOid)) {
            actions.push({kind: 'testRebase', key: landed.key, branch: read.headRef, headOid: read.headOid});
        }
    }
    return actions;
}

function headAction(
    landed: LandedPullRequest,
    read: LanePullRequestRead,
    lane: LaneInput,
    memory: RunnerMemory,
): LaneAction | null {
    if (landed.stage.kind !== 'head') return null;
    switch (landed.stage.step) {
        case 'updating': {
            const cancelled = read.runs.filter((run) => run.state === 'cancelled' && !memory.rerun.has(run.id));
            if (read.mergeState !== 'behind' && cancelled.length > 0) {
                return {kind: 'rerun', key: landed.key, runIds: cancelled.map((run) => run.id)};
            }
            const asked = memory.updated.get(landed.key);
            if (asked && asked.headOid === read.headOid && lane.now - asked.at < UPDATE_PATIENCE_MS) return null;
            return {kind: 'update', key: landed.key, pullRequestId: read.id, headOid: read.headOid};
        }
        case 'checks':
            return null;
        case 'merging': {
            if (!isGreen(read, lane.rules)) return null;
            const method = mergeMethod(lane.mergeMethods, lane.rules);
            if (!method) {
                const reason = 'No merge method is allowed by both the repository and its rules';
                return {
                    kind: 'needsYou',
                    key: landed.key,
                    headOid: read.headOid,
                    reason: {kind: 'merge-refused', reason},
                };
            }
            return {kind: 'merge', key: landed.key, number: read.number, sha: read.headOid, method};
        }
    }
}

/**
 * The head is green: GitHub says it can merge, and every required context
 * passed (or was skipped) on its head commit. Without required checks, every
 * check that ran must have.
 */
export function isGreen(read: LanePullRequestRead, rules: TrunkRules): boolean {
    if (!MERGEABLE_STATES.includes(read.mergeState)) return false;
    const done = (state: string) => state === 'passed' || state === 'skipped';
    if (rules.requiredChecks.length === 0) return read.checks.every((check) => done(check.state));
    return rules.requiredChecks.every((context) => {
        const checks = read.checks.filter((check) => check.name === context);
        return checks.length > 0 && checks.every((check) => done(check.state));
    });
}

/** The first merge method the repository's settings and its rules both allow; null when none is. */
export function mergeMethod(allowed: readonly MergeMethod[], rules: TrunkRules): MergeMethod | null {
    return (
        METHOD_ORDER.find(
            (method) =>
                allowed.includes(method) &&
                (rules.mergeMethods === null || rules.mergeMethods.includes(method)) &&
                !(method === 'merge' && rules.linearHistory),
        ) ?? null
    );
}

/** The test rebase made at these commits, if any. */
export function testRebaseFor(
    memory: RunnerMemory,
    key: string,
    headOid: string,
    trunkOid: string,
): TestRebaseResult | null {
    const result = memory.testRebases.get(key);
    return result && result.headOid === headOid && result.trunkOid === trunkOid ? result : null;
}

/**
 * Whether each waiting PR will conflict, as far as a test rebase at its
 * current head and trunk commits confirmed or refuted GitHub's `dirty`.
 */
export function confirmedConflicts(
    reads: readonly LanePullRequestRead[],
    keyOf: (read: LanePullRequestRead) => string,
    trunkOid: string,
    memory: RunnerMemory,
): Map<string, boolean> {
    const confirmed = new Map<string, boolean>();
    for (const read of reads) {
        const key = keyOf(read);
        const result = testRebaseFor(memory, key, read.headOid, trunkOid);
        if (result) confirmed.set(key, result.conflict);
    }
    return confirmed;
}

// ── What the writes answered ──

/** What follows a write: nothing until the next pass, read the lane again, update again, or set the PR aside. */
export type FollowUp =
    | {readonly kind: 'wait'}
    | {readonly kind: 'reread'}
    | {readonly kind: 'update'}
    | {readonly kind: 'fixing'; readonly cause: FixingCause}
    | {readonly kind: 'needsYou'; readonly reason: NeedsYouReason};

/** After a branch update: wait for its run, set a conflict aside, read a moved head again. */
export function afterUpdate(answer: {ok: true} | {ok: false; why: string; reason: string}): FollowUp {
    if (answer.ok) return {kind: 'wait'};
    switch (answer.why) {
        case 'conflict':
            return {kind: 'fixing', cause: 'conflict'};
        case 'moved':
            return {kind: 'reread'};
        case 'unavailable':
            return {kind: 'wait'};
        default:
            return {kind: 'needsYou', reason: {kind: 'merge-refused', reason: answer.reason}};
    }
}

/**
 * After a merge: read the lane again once it merged (the next PR becomes the
 * head) or when its head moved (409); update again when it cannot merge now
 * (405: behind the trunk again); try again next pass when GitHub was out of
 * reach; Needs you for anything else.
 */
export function afterMerge(answer: {ok: true} | {ok: false; status: number | null; reason: string}): FollowUp {
    if (answer.ok) return {kind: 'reread'};
    if (answer.status === 409) return {kind: 'reread'};
    if (answer.status === 405) return {kind: 'update'};
    if (answer.status === null || answer.status >= 500) return {kind: 'wait'};
    return {kind: 'needsYou', reason: {kind: 'merge-refused', reason: answer.reason}};
}

/**
 * The updates a lane did not push when its trunk moved: every PR waiting
 * behind the head, which a rebase-everything bot would have updated (and run
 * CI on). Nothing on the first read of a lane.
 */
export function updatesNotPushed(
    previousTrunkOid: string | null,
    trunkOid: string,
    entries: LaneInput['entries'],
): number {
    if (!previousTrunkOid || !trunkOid || previousTrunkOid === trunkOid) return 0;
    return entries.filter(({landed}) => landed.stage.kind === 'waiting').length;
}
