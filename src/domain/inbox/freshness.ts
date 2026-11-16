/**
 * How fresh each manager's inbox is, for the "Updated 3m ago" line in its
 * page's header: when its sources were last read, whether a read is in
 * flight, and whether the last read of one of them failed.
 *
 * A manager reads several sources, in groups: the Bug manager each opted-in
 * Bugsnag project (`bugsnag`); the Issue manager each watched repository's
 * open issues (`issues`) and the PRs of each repository with a started issue
 * (`pull-requests`). Each group's reads replace that group's sources as a
 * whole, so a source no longer read stops counting.
 */
import type {InboxManager} from './model';

/** One manager's freshness, as main pushes it with the summary. */
export interface ManagerFreshness {
    /**
     * The oldest last successful read across the manager's sources, epoch ms:
     * what it shows is at least this fresh. A source that never answered is
     * left out (its failure shows as `failed`); null when none answered yet.
     */
    readonly fetchedAt: number | null;
    /** One of its groups of sources is being read right now. */
    readonly refreshing: boolean;
    /** The last read of at least one of its sources failed: what it shows of that source is older. */
    readonly failed: boolean;
}

export type InboxFreshness = Readonly<Record<InboxManager, ManagerFreshness>>;

export const NO_FRESHNESS: ManagerFreshness = {fetchedAt: null, refreshing: false, failed: false};

export const NO_INBOX_FRESHNESS: InboxFreshness = {bug: NO_FRESHNESS, issue: NO_FRESHNESS};

/** A group of sources read together: which manager it fills. */
export type InboxReadGroup = 'bugsnag' | 'issues' | 'pull-requests';

export const READ_GROUP_MANAGER: Readonly<Record<InboxReadGroup, InboxManager>> = {
    bugsnag: 'bug',
    issues: 'issue',
    'pull-requests': 'issue',
};

/** A source's last read: when it last answered (null for never) and whether the last ask failed. */
export interface SourceRead {
    readonly lastOk: number | null;
    readonly failed: boolean;
}

/** A group's sources after a round of reads: `results` says which answered; the others are dropped. */
export function afterReads(
    before: ReadonlyMap<string, SourceRead>,
    results: ReadonlyMap<string, boolean>,
    now: number,
): Map<string, SourceRead> {
    const after = new Map<string, SourceRead>();
    for (const [source, ok] of results) {
        after.set(
            source,
            ok ? {lastOk: now, failed: false} : {lastOk: before.get(source)?.lastOk ?? null, failed: true},
        );
    }
    return after;
}

/** A manager's freshness from all its sources' reads, and whether a group is being read. */
export function managerFreshness(reads: Iterable<SourceRead>, refreshing: boolean): ManagerFreshness {
    let fetchedAt: number | null = null;
    let failed = false;
    for (const read of reads) {
        if (read.failed) failed = true;
        if (read.lastOk !== null && (fetchedAt === null || read.lastOk < fetchedAt)) fetchedAt = read.lastOk;
    }
    return {fetchedAt, refreshing, failed};
}

/** Both managers' freshness from each group's sources' reads and the groups being read. */
export function inboxFreshness(
    reads: ReadonlyMap<InboxReadGroup, ReadonlyMap<string, SourceRead>>,
    reading: ReadonlySet<InboxReadGroup>,
): InboxFreshness {
    const of = (manager: InboxManager): ManagerFreshness => {
        const groups = (Object.keys(READ_GROUP_MANAGER) as InboxReadGroup[]).filter(
            (group) => READ_GROUP_MANAGER[group] === manager,
        );
        return managerFreshness(
            groups.flatMap((group) => [...(reads.get(group)?.values() ?? [])]),
            groups.some((group) => reading.has(group)),
        );
    };
    return {bug: of('bug'), issue: of('issue')};
}

/** Whether two freshnesses say the same. */
export function sameFreshness(a: ManagerFreshness, b: ManagerFreshness): boolean {
    return a.fetchedAt === b.fetchedAt && a.refreshing === b.refreshing && a.failed === b.failed;
}
