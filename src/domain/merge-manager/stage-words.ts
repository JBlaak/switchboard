/**
 * The same stage words everywhere (#441, for #432): one table that turns a
 * landed PR's stage into what each place says of it.
 *
 * | Stage     | Sidebar / plan card pill               | In progress (Bug / Issue manager) |
 * |-----------|----------------------------------------|-----------------------------------|
 * | Waiting   | `landed · 2nd` (+ "will conflict")     | Landed · 2nd                      |
 * | Held      | `held · @ana`, `held · approval`, `held · on #433` | Held · @ana           |
 * | Head      | `merging`                              | Merging                           |
 * | Fixing    | `fixing`                               | Fixing                            |
 * | Needs you | `needs you`                            | Needs you                         |
 * | Merged    | `merged` (the session is archived)     | Merged (then Done)                |
 *
 * The sidebar's pill, the plan cards' `planQueuePill`, the project page's
 * Merge queue section and the inbox's In progress pill all read it, in both
 * lanes. PRs that are not landed keep each place's own words (only the
 * user's own PRs are ever landed).
 *
 * Pure, so the tests hold it still.
 */
import type {InboxItem, InboxStage} from '../inbox/model';
import {landedKey, type HeldReason, type LandedView, type LaneStage, type LaneStageKind, type LaneView} from './model';
import type {MergeManagerState} from './model';

/** What every place says of one landed PR's stage. */
export interface StageWords {
    /** The stage, for the pill's colour (`is-<kind>`). */
    readonly kind: LaneStageKind;
    /** The short pill: "landed · 2nd", "held · @ana", "merging", "fixing", "needs you". */
    readonly pill: string;
    /** The same, as a label: "Landed · 2nd", "Held · @ana", "Merging", "Fixing", "Needs you". */
    readonly label: string;
    /** "will conflict" on a waiting PR a test rebase found a conflict in; null otherwise. */
    readonly flag: string | null;
    /** A sentence for a tooltip. */
    readonly title: string;
}

/** A landed PR and the lane it waits in. */
export interface LandedLookup {
    readonly pullRequest: LandedView;
    readonly lane: LaneView;
}

/** The landed PR `repository#number`, with its lane; null when it is not landed. */
export function findLanded(state: MergeManagerState, repository: string, number: number): LandedLookup | null {
    const key = landedKey(repository, number);
    for (const lane of state.lanes) {
        const pullRequest = lane.pullRequests.find((candidate) => candidate.key === key);
        if (pullRequest) return {pullRequest, lane};
    }
    return null;
}

/** The words for a landed PR, in its lane (which names the PR a stacked one waits on). */
export function landedWords({pullRequest, lane}: LandedLookup): StageWords {
    const base = (branch: string): string => {
        const under = lane.pullRequests.find((candidate) => candidate.headRef === branch);
        return under ? '#' + under.number : branch;
    };
    return stageWords(pullRequest.stage, pullRequest.place, base);
}

/**
 * The words for a stage. `place` is the PR's place in its lane (1 for the
 * head); a queue lane's own number wins over it. `base` names the branch a
 * stacked PR waits on, "#433" when it is a landed PR's.
 */
export function stageWords(
    stage: LaneStage,
    place: number | null = null,
    base: (branch: string) => string = (branch) => branch,
): StageWords {
    switch (stage.kind) {
        case 'waiting': {
            const at = stage.position ?? place;
            const suffix = at === null ? '' : ' · ' + ordinal(at);
            const flag = stage.willConflict ? 'will conflict' : null;
            const where = at === null ? 'Landed, waiting for its turn' : `Landed, ${ordinal(at)} in its lane`;
            return words('waiting', 'landed' + suffix, flag, where + (flag ? '; it will conflict with the trunk' : ''));
        }
        case 'held':
            return heldWords(stage.reason, base);
        case 'head':
            return words('head', 'merging', null, HEAD_TITLE[stage.step]);
        case 'fixing':
            return words(
                'fixing',
                'fixing',
                null,
                stage.cause === 'conflict' ? 'A fix errand mends its conflict' : 'A fix errand mends its failed checks',
            );
        case 'needsYou':
            return words('needsYou', 'needs you', null, needsYouTitle(stage.reason));
        case 'merged':
            return words('merged', 'merged', null, 'Merged');
    }
}

function heldWords(reason: HeldReason, base: (branch: string) => string): StageWords {
    switch (reason.kind) {
        case 'approval':
            return words('held', 'held · approval', null, 'Held until it is approved');
        case 'review':
            return words('held', 'held · @' + reason.reviewer, null, `Held until @${reason.reviewer} reviews it`);
        case 'base': {
            const on = base(reason.base);
            return words('held', 'held · on ' + on, null, `Held until ${on} merges`);
        }
        case 'draft':
            return words('held', 'held · draft', null, 'Held while it is a draft');
    }
}

const HEAD_TITLE: Record<'updating' | 'checks' | 'merging', string> = {
    updating: 'The head: being updated on the trunk',
    checks: 'The head: its checks are running',
    merging: 'The head: merging',
};

function needsYouTitle(reason: Extract<LaneStage, {kind: 'needsYou'}>['reason']): string {
    switch (reason.kind) {
        case 'changes-requested':
            return 'Needs you: changes are requested';
        case 'unresolved-thread':
            return 'Needs you: a review thread is open';
        case 'errand-stopped':
            return reason.question
                ? `Needs you: the fix errand asked "${reason.question}"`
                : 'Needs you: the fix errand stopped without a fix';
        case 'merge-refused':
            return 'Needs you: ' + reason.reason;
    }
}

function words(kind: LaneStageKind, pill: string, flag: string | null, title: string): StageWords {
    return {kind, pill, label: pill.charAt(0).toUpperCase() + pill.slice(1), flag, title};
}

/** "1st", "2nd", "3rd", "11th". */
export function ordinal(n: number): string {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

// ── In progress ──

/** What an In progress pill says before a PR is landed (#414, #415). */
export const INBOX_STAGE_LABELS: Readonly<Record<InboxStage, string>> = {
    working: 'Working',
    needsYou: 'Needs you',
    prCi: 'PR · CI',
    ciFailing: 'CI failing',
    ready: 'Ready',
    queue: 'Queue',
    merged: 'Merged',
};

/** An In progress pill: its class (`is-<kind>`), its words and its tooltip. */
export interface InProgressPill {
    /** An `InboxStage`, or `landed-<stage>` once its PR is landed. */
    readonly kind: string;
    readonly label: string;
    readonly title: string | null;
}

/**
 * An in-progress item's pill: the landed stage's words once its PR is landed,
 * its own stage otherwise (Queue with its place when one is known).
 */
export function inProgressPill(
    stage: InboxStage,
    landed: LandedLookup | null,
    queuePosition: number | null = null,
): InProgressPill {
    if (!landed || stage === 'merged') {
        const label = INBOX_STAGE_LABELS[stage];
        return {
            kind: stage,
            label: stage === 'queue' && queuePosition ? `${label} · ${ordinal(queuePosition)}` : label,
            title: null,
        };
    }
    const said = landedWords(landed);
    return {kind: 'landed-' + said.kind, label: said.label, title: said.title};
}

/**
 * The landed PR an in-progress item's work opened, when it is landed: an
 * issue's in the issue's repository, a bug's Fix in the repository its
 * project is (`BugFix.repository`).
 */
export function landedForItem(merge: MergeManagerState, item: InboxItem): LandedLookup | null {
    if (item.facts.kind === 'issue') {
        const number = item.work?.pullRequest;
        return number ? findLanded(merge, item.facts.repository, number) : null;
    }
    const fix = item.fix;
    return fix?.pr ? findLanded(merge, fix.repository, fix.pr.number) : null;
}

/** Whether an in-progress item's landed PR needs you: the In progress tab's peach dot, on both managers' pages. */
export function needsYouInProgress(items: readonly InboxItem[], merge: MergeManagerState): boolean {
    return items.some(
        (item) => item.state.kind === 'inProgress' && landedForItem(merge, item)?.pullRequest.stage.kind === 'needsYou',
    );
}
