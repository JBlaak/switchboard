/**
 * The Merge manager's page by status: every one of the user's PRs, landed or
 * not, in one of a fixed list of groups, the ones that ask for attention
 * first.
 *
 * | Group             | Landed PRs                                  | Not landed PRs                  |
 * |-------------------|---------------------------------------------|---------------------------------|
 * | Needs you         | Needs you (any reason)                      | Changes asked, Checks failing   |
 * | Conflicts         | Waiting with "will conflict"                | Conflicts                       |
 * | Checks running    | The head, its checks running                | Checks running (approved)       |
 * | Fixing            | Fixing                                      | –                               |
 * | Merging           | The head, being updated or merged           | –                               |
 * | Ready to land     | –                                           | Approved and green              |
 * | In line           | Waiting (no conflict found), Held           | –                               |
 * | Waiting on review | –                                           | In review, No review asked      |
 * | Drafts            | –                                           | Draft                           |
 *
 * The first five are prominent (drawn as cards); the rest as compact rows;
 * Drafts starts folded. Merged today stays its own section under them.
 *
 * Within a group: landed PRs first, by repository and then their lane order
 * (as `pageLanes` gives them), then the not landed ones newest first.
 *
 * Pure, so the tests hold it still.
 */
import {notLandedKey, notLandedStatus, type OpenPullRequest} from './not-landed';
import type {PageLane, PageRow} from './page';

export type StatusGroupId =
    'needsYou' | 'conflicts' | 'checks' | 'fixing' | 'merging' | 'ready' | 'line' | 'review' | 'drafts';

/** The colour a group (and its rows' "now" marks) is drawn in. */
export type StatusTone = 'orange' | 'red' | 'blue' | 'yellow' | 'purple' | 'green' | 'grey';

export interface StatusGroupInfo {
    readonly id: StatusGroupId;
    /** "Needs you", "Checks running", … */
    readonly name: string;
    readonly tone: StatusTone;
    /** Drawn as cards with the full timeline; otherwise as compact rows. */
    readonly prominent: boolean;
    /** Starts folded (Drafts). */
    readonly folded: boolean;
    /** One line under the group's name: what being in it means. */
    readonly blurb: string;
}

/** Every group, in the page's order. */
export const STATUS_GROUPS: readonly StatusGroupInfo[] = [
    {
        id: 'needsYou',
        name: 'Needs you',
        tone: 'orange',
        prominent: true,
        folded: false,
        blurb: 'Only you can settle these. Landed ones keep their place in the lane until you do.',
    },
    {
        id: 'conflicts',
        name: 'Conflicts',
        tone: 'red',
        prominent: true,
        folded: false,
        blurb: 'Conflicting with the trunk now, or a test rebase found they will.',
    },
    {
        id: 'checks',
        name: 'Checks running',
        tone: 'blue',
        prominent: true,
        folded: false,
        blurb: 'CI is running on these right now.',
    },
    {
        id: 'fixing',
        name: 'Fixing',
        tone: 'yellow',
        prominent: true,
        folded: false,
        blurb: 'A fix errand is working on these by itself.',
    },
    {
        id: 'merging',
        name: 'Merging',
        tone: 'purple',
        prominent: true,
        folded: false,
        blurb: 'The head of its lane, being brought up to date or merged.',
    },
    {
        id: 'ready',
        name: 'Ready to land',
        tone: 'green',
        prominent: false,
        folded: false,
        blurb: 'Approved and green, not landed yet.',
    },
    {
        id: 'line',
        name: 'In line',
        tone: 'grey',
        prominent: false,
        folded: false,
        blurb: 'Landed, waiting for their turn or held.',
    },
    {
        id: 'review',
        name: 'Waiting on review',
        tone: 'grey',
        prominent: false,
        folded: false,
        blurb: 'Not landed; a reviewer has it, or nobody was asked yet.',
    },
    {id: 'drafts', name: 'Drafts', tone: 'grey', prominent: false, folded: true, blurb: 'Not landed, still drafts.'},
];

/** One row of a group: a landed PR (a lane's row) or a not landed one. */
export type StatusItem =
    | {readonly kind: 'lane'; readonly key: string; readonly row: PageRow}
    | {readonly kind: 'notLanded'; readonly key: string; readonly pr: OpenPullRequest};

export interface StatusGroup extends StatusGroupInfo {
    readonly items: readonly StatusItem[];
}

/** The group a landed PR is in. */
export function landedGroup(row: PageRow): StatusGroupId {
    const {stage} = row;
    switch (stage.kind) {
        case 'needsYou':
            return 'needsYou';
        case 'waiting':
            return stage.willConflict ? 'conflicts' : 'line';
        case 'held':
            return 'line';
        case 'head':
            return stage.step === 'checks' ? 'checks' : 'merging';
        case 'fixing':
            return 'fixing';
        case 'merged':
            // Never on the page (`pageLanes` leaves merged PRs out); the nearest group.
            return 'merging';
    }
}

/** The group a not landed PR is in, by `notLandedStatus`. */
export function notLandedGroup(pr: OpenPullRequest): StatusGroupId {
    switch (notLandedStatus(pr)) {
        case 'changesAsked':
        case 'checksFailing':
            return 'needsYou';
        case 'conflicts':
            return 'conflicts';
        case 'checksRunning':
            return 'checks';
        case 'ready':
            return 'ready';
        case 'inReview':
        case 'noReview':
            return 'review';
        case 'draft':
            return 'drafts';
    }
}

/**
 * The groups with anything in them, in `STATUS_GROUPS`' order. `notLanded`
 * is every not landed PR (already without the landed ones, as `notLanded`
 * gives them).
 */
export function statusGroups(lanes: readonly PageLane[], notLanded: readonly OpenPullRequest[]): StatusGroup[] {
    const items = new Map<StatusGroupId, StatusItem[]>(STATUS_GROUPS.map((group) => [group.id, []]));
    for (const lane of lanes) {
        for (const row of lane.rows) items.get(landedGroup(row))!.push({kind: 'lane', key: row.key, row});
    }
    const newestFirst = [...notLanded].sort((a, b) => b.createdAt - a.createdAt || b.number - a.number);
    for (const pr of newestFirst) {
        items.get(notLandedGroup(pr))!.push({kind: 'notLanded', key: notLandedKey(pr), pr});
    }
    return STATUS_GROUPS.map((group) => ({...group, items: items.get(group.id)!})).filter(
        (group) => group.items.length > 0,
    );
}

/** J/K's order: every item's key, top to bottom through the groups. */
export function statusKeys(groups: readonly StatusGroup[]): string[] {
    return groups.flatMap((group) => group.items.map((item) => item.key));
}

/** One repository's not landed PRs counted by group, in `STATUS_GROUPS`' order, for "+ 1 ready to land · 2 waiting on review". */
export interface GroupCount {
    readonly id: StatusGroupId;
    readonly name: string;
    readonly count: number;
}

/** `repository` (`owner/repo`, any case)'s not landed items in `groups`, counted by group; empty for none. */
export function notLandedCounts(groups: readonly StatusGroup[], repository: string): GroupCount[] {
    const id = repository.toLowerCase();
    return groups
        .map((group) => ({
            id: group.id,
            name: group.name,
            count: group.items.filter((item) => item.kind === 'notLanded' && item.pr.repository.toLowerCase() === id)
                .length,
        }))
        .filter((count) => count.count > 0);
}
