/**
 * What the Merge manager's page shows of Not landed, and how its selection
 * goes through it: the section's newest five under the lanes (and View all
 * when there are more), the Not landed page's rows for its project chip, the
 * J/K order (the lane rows, then the Not landed rows on screen), which row
 * the selection is on, and what a Not landed row's side view says.
 *
 * Pure, so it is tested in node; the page and its actions carry it out.
 */
import {
    NOT_LANDED_SHOWN,
    inRepository,
    notLanded,
    notLandedKey,
    notLandedStatus,
    repositoryShortName,
    type OpenPullRequest,
} from '../../../domain/merge-manager/not-landed';
import {pageLanes, rowKeys, type PageLane, type PageRow} from '../../../domain/merge-manager/page';
import type {MergeManagerState} from '../../../domain/merge-manager/model';
import type {MergeManagerSliceState} from '../../state/merge-manager-slice';

// ── The section ──

/** The section under the lanes: its rows, how many are not landed in all, and how many View all adds. */
export interface NotLandedSection {
    readonly rows: readonly OpenPullRequest[];
    readonly total: number;
    readonly more: number;
}

/** The newest five not in a lane; no rows (and no section) before the first read or when all are landed. */
export function notLandedSection(open: readonly OpenPullRequest[] | null, lanes: MergeManagerState): NotLandedSection {
    const all = notLanded(open ?? [], lanes);
    const rows = all.slice(0, NOT_LANDED_SHOWN);
    return {rows, total: all.length, more: all.length - rows.length};
}

/** The header's " · 3 not landed"; nothing for none. */
export function notLandedSubline(total: number): string {
    return total > 0 ? ` · ${total} not landed` : '';
}

/** The Not landed page's subline: "7 open pull requests of yours in 3 projects · newest first". */
export function notLandedPageSubline(rows: readonly OpenPullRequest[], projects: number): string {
    const prs = rows.length === 1 ? '1 open pull request' : `${rows.length} open pull requests`;
    const where = projects === 1 ? '1 project' : `${projects} projects`;
    return `${prs} of yours in ${where} · newest first`;
}

// ── Going through ──

/** The rows on screen: the lanes and the section's five, or (on the Not landed page) its chip's rows alone. */
export interface VisibleRows {
    readonly lanes: readonly PageLane[];
    readonly notLanded: readonly OpenPullRequest[];
}

export function visibleRows(slice: Pick<MergeManagerSliceState, 'state' | 'notLanded' | 'page'>): VisibleRows {
    if (slice.page.view === 'notLanded') {
        return {
            lanes: [],
            notLanded: inRepository(notLanded(slice.notLanded ?? [], slice.state), slice.page.repository),
        };
    }
    return {lanes: pageLanes(slice.state), notLanded: notLandedSection(slice.notLanded, slice.state).rows};
}

/** J/K's order: top to bottom through the lanes, then the Not landed rows. */
export function visibleRowKeys(rows: VisibleRows): string[] {
    return [...rowKeys(rows.lanes), ...rows.notLanded.map(notLandedKey)];
}

/** The row the selection is on: a lane's (a landed PR) or a Not landed one. */
export type PageSelection =
    | {readonly kind: 'lane'; readonly row: PageRow; readonly key: string}
    | {readonly kind: 'notLanded'; readonly pr: OpenPullRequest; readonly key: string};

/** The row with `key` on screen; null when it is not. A PR landed or unlanded keeps its key, so it is found again. */
export function findSelection(rows: VisibleRows, key: string | null): PageSelection | null {
    if (!key) return null;
    for (const lane of rows.lanes) {
        const row = lane.rows.find((candidate) => candidate.key === key);
        if (row) return {kind: 'lane', row, key};
    }
    const pr = rows.notLanded.find((candidate) => notLandedKey(candidate) === key);
    return pr ? {kind: 'notLanded', pr, key} : null;
}

/** The row with `key`, or the first row on screen when it is gone; null for no rows. */
export function pageSelection(rows: VisibleRows, key: string | null): PageSelection | null {
    const found = findSelection(rows, key);
    if (found) return found;
    const first = rows.lanes[0]?.rows[0];
    if (first) return {kind: 'lane', row: first, key: first.key};
    const pr = rows.notLanded[0];
    return pr ? {kind: 'notLanded', pr, key: notLandedKey(pr)} : null;
}

/**
 * J/K: the row to select. While the side view is closed it opens on the
 * current row first; then a step down or up, kept within the rows, from the
 * first or the last when none is current yet.
 */
export function nextRowKey(
    keys: readonly string[],
    current: string | null,
    detailOpen: boolean,
    step: 1 | -1,
): string | null {
    if (keys.length === 0) return null;
    if (!detailOpen && current) return current;
    const at = current ? keys.indexOf(current) : -1;
    const next = at === -1 ? (step === 1 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, at + step));
    return keys[next]!;
}

// ── The side view ──

/** One line of "Before it can merge": done, under way, waiting on someone, failing, asked of you, or nothing yet. */
export interface BeforeMergeItem {
    readonly tone: 'done' | 'running' | 'waiting' | 'failing' | 'warn' | 'none';
    readonly text: string;
}

/** Its checks, its conflicts with its base, and its approval. */
export function beforeMerge(pr: OpenPullRequest): BeforeMergeItem[] {
    return [checksItem(pr), conflictsItem(pr), approvalItem(pr)];
}

function checksItem(pr: OpenPullRequest): BeforeMergeItem {
    switch (pr.checks) {
        case 'success':
            return {tone: 'done', text: 'Checks green'};
        case 'pending':
            return {tone: 'running', text: 'Checks running'};
        case 'failure':
            return {tone: 'failing', text: 'Checks failing'};
        case null:
            return {tone: 'none', text: 'No checks'};
    }
}

function conflictsItem(pr: OpenPullRequest): BeforeMergeItem {
    switch (pr.mergeable) {
        case 'MERGEABLE':
            return {tone: 'done', text: 'No conflicts with its base'};
        case 'CONFLICTING':
            return {tone: 'failing', text: 'Conflicts with its base'};
        case 'UNKNOWN':
            return {tone: 'none', text: 'GitHub is still working out whether it conflicts with its base'};
    }
}

function approvalItem(pr: OpenPullRequest): BeforeMergeItem {
    if (pr.reviewDecision === 'APPROVED') {
        return {tone: 'done', text: pr.approvedBy.length > 0 ? `Approved by ${pr.approvedBy.join(', ')}` : 'Approved'};
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
        return {
            tone: 'warn',
            text:
                pr.changesRequestedBy.length > 0
                    ? `Changes asked by ${pr.changesRequestedBy.join(', ')}`
                    : 'Changes asked',
        };
    }
    if (pr.reviewRequested.length > 0) {
        return {tone: 'waiting', text: `Review asked of ${pr.reviewRequested.join(', ')}`};
    }
    return {tone: 'none', text: 'No review asked'};
}

/** "If you land it now": an approved PR waits its turn, any other is held until it is approved; a draft cannot land. */
export function ifLandedNow(pr: OpenPullRequest): string {
    const lane = `It joins ${repositoryShortName(pr.repository)}’s lane`;
    if (notLandedStatus(pr) === 'draft') return 'A draft cannot be landed. Mark it ready for review first.';
    if (pr.reviewDecision === 'APPROVED') return `${lane} and waits its turn.`;
    return `${lane} and is held there until it is approved. The Merge manager never approves for you.`;
}
