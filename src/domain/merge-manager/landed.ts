/**
 * Which PRs are landed (#434), and what landing, unlanding and a poll do to
 * them.
 *
 * - **Land** takes the user's own open, non-draft PR. In a queue lane it
 *   means the `automerge:opt-in` label; in a Switchboard lane, joining the
 *   lane. Either way `autorebase:opt-in` goes: the head is updated by its
 *   lane, nothing else is.
 * - **Unland** takes it back: the queue's labels off in a queue lane, out of
 *   the lane in a Switchboard lane. `autorebase:opt-in` is not put back, and
 *   running CI and errands are left alone.
 * - **A poll** (`syncLane`) folds one repository's lane read in: in a queue
 *   lane every PR of the user's carrying a queue label is landed, wherever
 *   the label was added, and one that lost them all is unlanded; a landed PR
 *   that was closed without merging unlands itself; each PR's stage is read
 *   again (`stages.ts`). A merged PR keeps its stage, and is dropped
 *   `MERGED_KEPT_MS` after it merged.
 */
import {QUEUE_LABELS} from '../project/merge-queue';
import {byLandOrder, hasLabel, queueLaneStage, switchboardLaneStages} from './stages';
import {landedKey} from './model';
import type {
    LandedPullRequest,
    LandedView,
    LaneKind,
    LanePullRequestRead,
    LaneRead,
    LaneView,
    MergeManagerState,
    SetAside,
    TrunkRules,
} from './model';

/** How long a merged PR stays in its lane, for the Merge manager's page and the hand-off summary. */
export const MERGED_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** The labels that put a PR in a queue lane. */
const QUEUE_LANE_LABELS = [QUEUE_LABELS.optIn, QUEUE_LABELS.next, QUEUE_LABELS.failed];

// ── Land and unland ──

/** Why a PR cannot be landed, or null when it can. */
export function landRefusal(read: LanePullRequestRead, viewer: string): string | null {
    if (!read.author || read.author.toLowerCase() !== viewer.toLowerCase()) return 'Only your own pull requests land';
    if (read.state !== 'open') return `#${read.number} is ${read.state}`;
    if (read.draft) return 'Mark it ready for review first';
    return null;
}

/** The label writes landing takes. */
export function landLabels(read: LanePullRequestRead, kind: LaneKind): {add: string[]; remove: string[]} {
    const add = kind === 'queue' && !hasLabel(read, QUEUE_LABELS.optIn) ? [QUEUE_LABELS.optIn] : [];
    const remove = hasLabel(read, QUEUE_LABELS.rebaseOptIn) ? [QUEUE_LABELS.rebaseOptIn] : [];
    return {add, remove};
}

/** The labels unlanding takes off: the queue's own, in a queue lane; nothing in a Switchboard lane. */
export function unlandLabels(read: LanePullRequestRead, kind: LaneKind): string[] {
    return kind === 'queue' ? QUEUE_LANE_LABELS.filter((label) => hasLabel(read, label)) : [];
}

/** A PR just landed, waiting until the next pass places it. */
export function landed(read: LanePullRequestRead, kind: LaneKind, now: number): LandedPullRequest {
    return {
        key: landedKey(read.repository, read.number),
        repository: read.repository,
        number: read.number,
        title: read.title,
        url: read.url,
        headRef: read.headRef,
        lane: kind,
        landedAt: now,
        stage: {kind: 'waiting', willConflict: read.mergeState === 'dirty', position: null},
        setAside: null,
        errand: null,
    };
}

/** Set a PR aside on the commit it is at, or clear its set-aside (null). */
export function setAside(pr: LandedPullRequest, aside: SetAside | null): LandedPullRequest {
    return {...pr, setAside: aside};
}

// ── A poll ──

/** One repository's lane after a poll: every landed PR in it, and the keys that left. */
export interface LaneSync {
    landed: LandedPullRequest[];
    removed: string[];
}

/**
 * Fold a lane read into the repository's landed PRs (`known`, any order).
 * A landed PR the read left out keeps what it had; a merged one is not read
 * again and keeps its stage. `conflicts` is what test rebases found of
 * waiting PRs in a Switchboard lane (#435), by key.
 */
export function syncLane(
    known: readonly LandedPullRequest[],
    read: LaneRead,
    kind: LaneKind,
    now: number,
    conflicts?: ReadonlyMap<string, boolean>,
): LaneSync {
    const reads = new Map(read.pullRequests.map((pr) => [landedKey(pr.repository, pr.number), pr]));
    const removed: string[] = [];
    const kept: LandedPullRequest[] = [];
    const byKey = new Map(known.map((pr) => [pr.key, pr]));

    // In a queue lane, the user's PRs carrying a queue label are landed, however the label got there.
    if (kind === 'queue') {
        for (const [key, pr] of reads) {
            if (byKey.has(key) || pr.state !== 'open' || pr.draft) continue;
            if (!isMine(pr, read.viewer) || !QUEUE_LANE_LABELS.some((label) => hasLabel(pr, label))) continue;
            byKey.set(key, landed(pr, kind, now));
        }
    }

    for (const pr of byKey.values()) {
        const fresh = reads.get(pr.key);
        if (pr.stage.kind === 'merged' || !fresh) {
            kept.push(pr);
            continue;
        }
        if (fresh.state === 'closed') removed.push(pr.key);
        else if (kind === 'queue' && fresh.state === 'open' && !QUEUE_LANE_LABELS.some((l) => hasLabel(fresh, l))) {
            removed.push(pr.key);
        } else {
            kept.push({...pr, title: fresh.title, url: fresh.url, headRef: fresh.headRef, lane: kind});
        }
    }

    const staged =
        kind === 'queue' ? stageQueueLane(kept, reads, now) : stageSwitchboardLane(kept, reads, read, now, conflicts);
    return {landed: staged, removed};
}

function stageQueueLane(
    prs: readonly LandedPullRequest[],
    reads: ReadonlyMap<string, LanePullRequestRead>,
    now: number,
): LandedPullRequest[] {
    return prs.map((pr) => {
        const fresh = reads.get(pr.key);
        if (pr.stage.kind === 'merged' || !fresh) return pr;
        const aside = pr.setAside && pr.setAside.headOid === fresh.headOid ? pr.setAside : null;
        return {...pr, stage: queueLaneStage(fresh, aside, now), setAside: aside};
    });
}

function stageSwitchboardLane(
    prs: readonly LandedPullRequest[],
    reads: ReadonlyMap<string, LanePullRequestRead>,
    read: LaneRead,
    now: number,
    conflicts: ReadonlyMap<string, boolean> | undefined,
): LandedPullRequest[] {
    const entries = prs
        .filter((pr) => pr.stage.kind !== 'merged' && reads.has(pr.key))
        .map((pr) => ({landed: pr, read: reads.get(pr.key)!}));
    const outcomes = new Map(
        switchboardLaneStages(entries, {trunk: read.trunk, rules: read.rules, now, conflicts}).map((o) => [o.key, o]),
    );
    return prs.map((pr) => {
        const outcome = outcomes.get(pr.key);
        return outcome ? {...pr, stage: outcome.stage, setAside: outcome.setAside} : pr;
    });
}

/** The merged PRs whose time in their lane is up. */
export function expiredMerged(prs: readonly LandedPullRequest[], now: number): string[] {
    return prs.filter((pr) => pr.stage.kind === 'merged' && now - pr.stage.at >= MERGED_KEPT_MS).map((pr) => pr.key);
}

function isMine(pr: LanePullRequestRead, viewer: string): boolean {
    return pr.author !== null && pr.author.toLowerCase() === viewer.toLowerCase();
}

// ── What the renderer is shown ──

/**
 * Every lane with a landed PR, by repository, each in land order with its
 * merged PRs last, and the PRs that need you counted. `rules` are the
 * repositories' trunk rules as last read.
 */
export function mergeManagerState(
    prs: readonly LandedPullRequest[],
    rules: ReadonlyMap<string, TrunkRules>,
): MergeManagerState {
    const byRepository = new Map<string, LandedPullRequest[]>();
    for (const pr of prs) {
        const repository = pr.repository.toLowerCase();
        byRepository.set(repository, [...(byRepository.get(repository) ?? []), pr]);
    }
    const lanes = [...byRepository.values()]
        .map((lane) => laneView(lane, rules))
        .sort((a, b) => a.repository.localeCompare(b.repository));
    return {lanes, needsYou: prs.filter((pr) => pr.stage.kind === 'needsYou').length};
}

function laneView(prs: readonly LandedPullRequest[], rules: ReadonlyMap<string, TrunkRules>): LaneView {
    const ordered = prs.map((pr) => ({landed: pr})).sort(byLandOrder);
    const open = ordered.filter(({landed}) => landed.stage.kind !== 'merged');
    const done = ordered.filter(({landed}) => landed.stage.kind === 'merged');
    const kind = (open[0] ?? ordered[0]).landed.lane;
    const repository = ordered[0].landed.repository;
    let next = open.some(({landed}) => landed.stage.kind === 'head') ? 2 : 1;
    const placed = (pr: LandedPullRequest): LandedView => {
        if (pr.stage.kind === 'head') return {...pr, place: 1};
        if (pr.stage.kind !== 'waiting') return {...pr, place: null};
        return {...pr, place: kind === 'queue' ? pr.stage.position : next++};
    };
    return {
        repository,
        kind,
        approvalLostOnPush:
            kind === 'switchboard' && (rules.get(repository.toLowerCase())?.approvalLostOnPush ?? false),
        pullRequests: [...open, ...done].map(({landed}) => placed(landed)),
    };
}

/** A landed PR as its lane shows it, place and all; null when it is not landed. */
export function landedView(state: MergeManagerState, key: string): LandedView | null {
    for (const lane of state.lanes) {
        const found = lane.pullRequests.find((pr) => pr.key === key);
        if (found) return found;
    }
    return null;
}
