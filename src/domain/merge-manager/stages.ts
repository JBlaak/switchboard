/**
 * The stage model's two readers (#423, #434): the stage of each landed PR,
 * from the queue's labels and `automerge` status in a queue lane, and from
 * Switchboard's own lane state in a Switchboard lane.
 *
 * **Queue lane.** The queue Action decides; this reads what it wrote back
 * (`parseAutomergeStatus`): "First in the merge queue" is the head, "Number N"
 * is waiting, "Waits for an approval / a review" is held, as is a PR stacked
 * on a branch that has not merged. `automerge:failed` is Fixing for a failed
 * check or a conflict, which a fix errand can mend, and Needs you for
 * requested changes, a thread or a refused merge.
 *
 * **Switchboard lane.** In land order. A PR is, in this order of precedence:
 *
 * 1. Merged, once GitHub says so;
 * 2. Needs you, when an errand gave up on its commit, changes are requested
 *    or a review thread is open;
 * 3. Fixing, while an errand works on the commit it failed out on;
 * 4. Held, as a draft, stacked on an unmerged branch, with a requested
 *    review outstanding, or without an approval the branch rules require
 *    (GitHub's review decision is "review required"; with no such rule
 *    there is nothing to wait for);
 * 5. otherwise up for the head. The head is the PR that was the head last
 *    time, while it is still up for it (no pre-emption: a PR earlier in land
 *    order that becomes ready waits until the head merges or fails out), or
 *    else the first one in land order. The rest wait.
 *
 * A head fails out on a conflict, or on a required check that failed on a
 * commit that is up to date with the trunk (one that is behind gets a new run
 * from its update first). It is set aside as Fixing on that commit, and the
 * next PR up becomes the head in the same pass.
 *
 * A set-aside (`SetAside`) lasts as long as the PR's head commit: a push,
 * the errand's or the author's, clears it and the PR goes back to its place,
 * its landed time unchanged.
 */
import {QUEUE_LABELS, failureKind, parseAutomergeStatus} from '../project/merge-queue';
import type {
    DecidingCheck,
    HeadStep,
    HeldReason,
    LandedFacts,
    LandedPullRequest,
    LanePullRequestRead,
    LaneStage,
    NeedsYouReason,
    SetAside,
    TrunkRules,
} from './model';

// ── Queue lane ──

/** A queue lane PR's stage, from what the queue wrote on it. */
export function queueLaneStage(read: LanePullRequestRead, setAside: SetAside | null, now: number): LaneStage {
    if (read.state === 'merged') return merged(read, now);
    const aside = currentSetAside(setAside, read);
    if (aside?.kind === 'needsYou' && aside.reason) return {kind: 'needsYou', reason: aside.reason};

    const parsed = read.automerge ? parseAutomergeStatus(read.automerge) : null;
    const status = parsed?.status ?? null;
    if (hasLabel(read, QUEUE_LABELS.failed) || status?.kind === 'failed') {
        const reason = status?.kind === 'failed' ? status.reason : 'Failed in the merge queue';
        return failedStage(reason);
    }
    if (!status) return waiting(read, null);
    switch (status.kind) {
        case 'head':
            return {kind: 'head', step: queueHeadStep(read)};
        case 'queued':
            return waiting(read, status.position);
        case 'held':
            return {kind: 'held', reason: status.waitsFor};
        case 'outside':
            if (status.why.kind === 'base') return {kind: 'held', reason: {kind: 'base', base: status.why.base}};
            if (status.why.kind === 'draft' || status.why.kind === 'stack-draft') {
                return {kind: 'held', reason: {kind: 'draft'}};
            }
            return waiting(read, null);
        case 'unknown':
            return waiting(read, null);
    }
}

/** What the queue's failure reason makes of a PR: Fixing when an errand can mend it, Needs you otherwise. */
function failedStage(reason: string): LaneStage {
    switch (failureKind(reason)) {
        case 'ci':
            return {kind: 'fixing', cause: 'checks'};
        case 'conflict':
            return {kind: 'fixing', cause: 'conflict'};
        case 'changes-requested':
            return {kind: 'needsYou', reason: {kind: 'changes-requested'}};
        case 'unresolved-thread':
            return {kind: 'needsYou', reason: {kind: 'unresolved-thread'}};
        case 'merge-refused':
        case 'other':
            return {kind: 'needsYou', reason: {kind: 'merge-refused', reason}};
    }
}

/**
 * The queue head's step: updating until its checks show up, checks while any
 * runs or waits, merging once none does (a failed required check fails the
 * entry instead, so whatever is left is the merge).
 */
function queueHeadStep(read: LanePullRequestRead): HeadStep {
    if (read.checks.length === 0) return 'updating';
    return read.checks.some(unfinished) ? 'checks' : 'merging';
}

// ── Switchboard lane ──

/** A landed PR and what the poll read of it. */
export interface LaneEntry {
    readonly landed: LandedPullRequest;
    readonly read: LanePullRequestRead;
}

/** Where a Switchboard lane PR ends up after a pass. */
export interface LaneOutcome {
    readonly key: string;
    readonly stage: LaneStage;
    readonly setAside: SetAside | null;
}

/**
 * Every PR's stage in one Switchboard lane, in land order. `conflicts` holds
 * what a test rebase found for a waiting PR (#435), which outranks GitHub's
 * `dirty`.
 */
export function switchboardLaneStages(
    entries: readonly LaneEntry[],
    lane: {trunk: string; rules: TrunkRules; now: number; conflicts?: ReadonlyMap<string, boolean>},
): LaneOutcome[] {
    const ordered = [...entries].sort(byLandOrder);
    const outcomes = new Map<string, LaneOutcome>();
    const up: LaneEntry[] = [];

    for (const entry of ordered) {
        const {landed, read} = entry;
        const setAside = currentSetAside(landed.setAside, read);
        const stage = settledStage(read, setAside, lane.trunk, lane.now);
        if (stage) outcomes.set(landed.key, {key: landed.key, stage, setAside});
        else {
            up.push(entry);
            const stage: LaneStage = {
                kind: 'waiting',
                willConflict: lane.conflicts?.get(landed.key) ?? read.mergeState === 'dirty',
                position: null,
            };
            outcomes.set(landed.key, {key: landed.key, stage, setAside});
        }
    }

    // The head stays the head while it is up for it; the rest queue behind it in land order.
    const previous = up.findIndex((entry) => entry.landed.stage.kind === 'head');
    const candidates = previous >= 0 ? [up[previous], ...up.filter((_, index) => index !== previous)] : up;
    for (const {landed, read} of candidates) {
        const failure = failOut(read, lane.rules);
        if (failure) {
            const setAside: SetAside = {kind: 'fixing', cause: failure, reason: null, headOid: read.headOid};
            outcomes.set(landed.key, {key: landed.key, stage: {kind: 'fixing', cause: failure}, setAside});
            continue;
        }
        const setAside = outcomes.get(landed.key)?.setAside ?? null;
        outcomes.set(landed.key, {key: landed.key, stage: {kind: 'head', step: headStep(read, lane.rules)}, setAside});
        break;
    }

    return ordered.map((entry) => outcomes.get(entry.landed.key)!);
}

/** A PR's stage when it is not up for the head; null when it is. */
function settledStage(
    read: LanePullRequestRead,
    setAside: SetAside | null,
    trunk: string,
    now: number,
): LaneStage | null {
    if (read.state === 'merged') return merged(read, now);
    if (setAside?.kind === 'needsYou' && setAside.reason) return {kind: 'needsYou', reason: setAside.reason};
    const needsYou = feedback(read);
    if (needsYou) return {kind: 'needsYou', reason: needsYou};
    if (setAside?.kind === 'fixing') return {kind: 'fixing', cause: setAside.cause ?? 'checks'};
    const held = heldReason(read, trunk);
    return held ? {kind: 'held', reason: held} : null;
}

/** Review feedback only the author can answer. */
function feedback(read: LanePullRequestRead): NeedsYouReason | null {
    if (read.review === 'changes_requested') return {kind: 'changes-requested'};
    if (read.unresolvedThreads > 0) return {kind: 'unresolved-thread'};
    return null;
}

/**
 * Why a PR is passed over, or null when nothing holds it. Switchboard never approves.
 * An approval is only waited for when the branch rules ask for one: without
 * that rule GitHub gives no review decision, and the PR is free to land.
 */
export function heldReason(read: LanePullRequestRead, trunk: string): HeldReason | null {
    if (read.draft) return {kind: 'draft'};
    if (read.baseRef && read.baseRef !== trunk) return {kind: 'base', base: read.baseRef};
    const reviewer = read.requestedReviewers[0];
    if (reviewer) return {kind: 'review', reviewer, team: reviewer.includes('/')};
    if (read.review === 'review_required' && read.approvedBy.length === 0) return {kind: 'approval'};
    return null;
}

/** The checks that decide a merge: the required ones, or every check when the rules name none. */
function deciding(read: LanePullRequestRead, rules: TrunkRules): LanePullRequestRead['checks'] {
    if (rules.requiredChecks.length === 0) return read.checks;
    return read.checks.filter((check) => rules.requiredChecks.includes(check.name));
}

/** Why the head fails out, or null when it does not. */
function failOut(read: LanePullRequestRead, rules: TrunkRules): 'conflict' | 'checks' | null {
    if (read.mergeState === 'dirty') return 'conflict';
    if (read.mergeState === 'behind') return null;
    return deciding(read, rules).some((check) => check.state === 'failed') ? 'checks' : null;
}

/**
 * What a read says of a landed PR beyond its stage, for the Merge manager's
 * page (#439): who approved it and its deciding checks, a required one that
 * has not reported yet as `missing`.
 */
export function landedFacts(read: LanePullRequestRead, rules: TrunkRules): LandedFacts {
    const checks: DecidingCheck[] =
        rules.requiredChecks.length === 0
            ? read.checks.map(({name, state}) => ({name, state}))
            : rules.requiredChecks.map((name) => ({
                  name,
                  state: read.checks.find((check) => check.name === name)?.state ?? 'missing',
              }));
    return {approvedBy: read.approvedBy, checks};
}

/**
 * The head's step: updating while it is behind the trunk or a deciding check
 * was cancelled (it needs a new run), checks while a required one has not
 * reported or any deciding one runs, merging once they all passed.
 */
export function headStep(read: LanePullRequestRead, rules: TrunkRules): HeadStep {
    if (read.mergeState === 'behind') return 'updating';
    const checks = deciding(read, rules);
    if (checks.some((check) => check.state === 'cancelled')) return 'updating';
    const missing = rules.requiredChecks.some((context) => !read.checks.some((check) => check.name === context));
    return missing || checks.some(unfinished) ? 'checks' : 'merging';
}

// ── Shared ──

/** A set-aside still holds while the PR's head commit is the one it was set on. */
export function currentSetAside(setAside: SetAside | null, read: LanePullRequestRead): SetAside | null {
    return setAside && setAside.headOid === read.headOid ? setAside : null;
}

export function byLandOrder(a: {landed: LandedPullRequest}, b: {landed: LandedPullRequest}): number {
    return a.landed.landedAt - b.landed.landedAt || a.landed.number - b.landed.number;
}

function waiting(read: LanePullRequestRead, position: number | null): LaneStage {
    return {kind: 'waiting', willConflict: read.mergeState === 'dirty', position};
}

function merged(read: LanePullRequestRead, now: number): LaneStage {
    const at = read.mergedAt ? Date.parse(read.mergedAt) : NaN;
    return {kind: 'merged', at: Number.isFinite(at) ? at : now};
}

function unfinished(check: LanePullRequestRead['checks'][number]): boolean {
    return check.state === 'running' || check.state === 'queued';
}

export function hasLabel(read: Pick<LanePullRequestRead, 'labels'>, label: string): boolean {
    return read.labels.some((name) => name.toLowerCase() === label.toLowerCase());
}
