/**
 * Not landed: the user's own open PRs in the projects Switchboard knows that
 * are not in a lane yet, on the Merge manager's page (its newest five, then
 * View all) and on its Not landed page (all of them, by project).
 *
 * Main reads them with one search (`openPullRequests`) and keeps those in a
 * repository one of the local projects checks out; what is in a lane is
 * left out here, against the lanes the renderer was last pushed, so a Land
 * or an Unland moves a PR between the two without another read.
 *
 * Each row says what stands between it and landing (`notLandedStatus`),
 * newest first by when the PR was opened.
 */
import {landedKey, type MergeManagerState} from './model';

/** One of the user's open PRs, as main read it for Not landed. */
export interface OpenPullRequest {
    /** `owner/repo`. */
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly isDraft: boolean;
    /** When it was opened, epoch ms. */
    readonly createdAt: number;
    readonly headRef: string;
    readonly reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
    /** Whether GitHub can merge it into its base without conflicts; UNKNOWN while GitHub works it out. */
    readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    /** Its head commit's checks rolled up; null when it has none. */
    readonly checks: 'success' | 'failure' | 'pending' | null;
    /** Who a review is asked of and has not answered (logins, or `org/team`). */
    readonly reviewRequested: readonly string[];
    /** Whose latest review asks for changes. */
    readonly changesRequestedBy: readonly string[];
    /** Whose latest review approves it. */
    readonly approvedBy: readonly string[];
}

/** What stands between a PR and landing. */
export type NotLandedStatus =
    | 'ready'
    | 'checksRunning'
    | 'inReview'
    | 'noReview'
    | 'changesAsked'
    | 'checksFailing'
    | 'conflicts'
    | 'draft';

/** How many the Merge manager's page shows before View all. */
export const NOT_LANDED_SHOWN = 5;

/**
 * What a PR's row says: a draft first, then what only the user can fix
 * (conflicts, failing checks, changes asked), then approved (ready, or its
 * checks still running), then waiting on a reviewer or on nobody yet.
 */
export function notLandedStatus(pr: OpenPullRequest): NotLandedStatus {
    if (pr.isDraft) return 'draft';
    if (pr.mergeable === 'CONFLICTING') return 'conflicts';
    if (pr.checks === 'failure') return 'checksFailing';
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changesAsked';
    if (pr.reviewDecision === 'APPROVED') return pr.checks === 'pending' ? 'checksRunning' : 'ready';
    if (pr.reviewRequested.length > 0) return 'inReview';
    return 'noReview';
}

const LABELS: Record<NotLandedStatus, string> = {
    ready: 'Approved · checks green',
    checksRunning: 'Checks running',
    inReview: 'In review',
    noReview: 'No review asked',
    changesAsked: 'Changes asked',
    checksFailing: 'Checks failing',
    conflicts: 'Conflicts',
    draft: 'Draft',
};

/** The row's pill. */
export function notLandedLabel(status: NotLandedStatus): string {
    return LABELS[status];
}

/** The pill's tone: ready, waiting on someone, needs the user, or a draft. */
export function notLandedTone(status: NotLandedStatus): 'ready' | 'waiting' | 'running' | 'warn' | 'error' | 'draft' {
    switch (status) {
        case 'ready':
            return 'ready';
        case 'checksRunning':
            return 'running';
        case 'inReview':
        case 'noReview':
            return 'waiting';
        case 'changesAsked':
            return 'warn';
        case 'checksFailing':
        case 'conflicts':
            return 'error';
        case 'draft':
            return 'draft';
    }
}

/** Whether the row offers Land it: every open PR but a draft (a landed PR is held until it is approved). */
export function canLand(pr: OpenPullRequest): boolean {
    return !pr.isDraft;
}

/** The repository's short name: `switchboard` for `JBlaak/switchboard`. */
export function repositoryShortName(repository: string): string {
    return repository.slice(repository.indexOf('/') + 1);
}

/** How long ago, roughly: "2 h ago", "3 d ago", "just now". */
export function openedAgo(createdAt: number, now: number): string {
    const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
}

/** What the row's second line adds after the age: who it waits on, or what is wrong. */
export function notLandedWhy(pr: OpenPullRequest): string | null {
    switch (notLandedStatus(pr)) {
        case 'inReview':
            return `review asked of ${pr.reviewRequested.join(', ')}`;
        case 'changesAsked':
            return pr.changesRequestedBy.length > 0 ? `changes asked by ${pr.changesRequestedBy.join(', ')}` : null;
        case 'conflicts':
            return 'conflicts with its base';
        case 'ready':
        case 'checksRunning':
            return pr.approvedBy.length > 0 ? `approved by ${pr.approvedBy.join(', ')}` : null;
        default:
            return null;
    }
}

/** The row's second line: its repository, branch, age and why. */
export function notLandedMeta(pr: OpenPullRequest, now: number): string {
    return [repositoryShortName(pr.repository), pr.headRef, 'opened ' + openedAgo(pr.createdAt, now), notLandedWhy(pr)]
        .filter((part): part is string => !!part)
        .join(' · ');
}

/** Its key: the same as it takes once landed (`landedKey`), so the page's selection is one key space. */
export function notLandedKey(pr: OpenPullRequest): string {
    return landedKey(pr.repository, pr.number);
}

/** Every open PR not in a lane (a merged one in a lane counts as gone), newest opened first. */
export function notLanded(open: readonly OpenPullRequest[], lanes: MergeManagerState): OpenPullRequest[] {
    const inLane = new Set<string>();
    for (const lane of lanes.lanes) for (const pr of lane.pullRequests) inLane.add(pr.key);
    return open
        .filter((pr) => !inLane.has(notLandedKey(pr)))
        .sort((a, b) => b.createdAt - a.createdAt || b.number - a.number);
}

/** The projects on the Not landed page's chips: each repository with how many, most first, then by name. */
export function notLandedRepositories(rows: readonly OpenPullRequest[]): {repository: string; count: number}[] {
    const counts = new Map<string, {repository: string; count: number}>();
    for (const pr of rows) {
        const id = pr.repository.toLowerCase();
        const entry = counts.get(id) ?? {repository: pr.repository, count: 0};
        entry.count++;
        counts.set(id, entry);
    }
    return [...counts.values()].sort(
        (a, b) => b.count - a.count || repositoryShortName(a.repository).localeCompare(repositoryShortName(b.repository)),
    );
}

/** The rows a project chip leaves; all of them for none. */
export function inRepository(rows: readonly OpenPullRequest[], repository: string | null): OpenPullRequest[] {
    if (repository === null) return [...rows];
    return rows.filter((pr) => pr.repository.toLowerCase() === repository.toLowerCase());
}
