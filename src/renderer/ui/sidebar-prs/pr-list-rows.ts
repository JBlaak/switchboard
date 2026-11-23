/**
 * What the sidebar's pull request list shows: every one of your open PRs,
 * landed (in a Merge manager lane) or not, under a header per repository.
 *
 * It is the Merge manager's page by status in one column: the same PRs
 * (`pageLanes` and `notLanded`), the same groups and their order
 * (`statusGroups`: Needs you first, Drafts last), so within a repository the
 * PR that asks for you is on top and a repository with one comes first
 * (`byRepository` keeps each where its first PR stands). Each row says its
 * group's colour and the Merge manager's words for where it stands:
 * "#523 · Ready to land", "#498 · Landed · 2nd", "#501 · Checks failing".
 *
 * Land it is offered where the Merge manager offers it (`canLand`: a not
 * landed PR that is no draft); a ready one shows it always, the others only
 * under the pointer or the cursor.
 *
 * The keys (`pullRequestListKey`), the cursor's steps and which row's PR the
 * main area shows are here too. Pure, so it is tested in node; the list
 * draws it.
 */
import {pageLanes, rowStageLabel} from '../../../domain/merge-manager/page';
import {canLand, notLanded, notLandedLabel, notLandedStatus} from '../../../domain/merge-manager/not-landed';
import type {OpenPullRequest} from '../../../domain/merge-manager/not-landed';
import type {MergeManagerState} from '../../../domain/merge-manager/model';
import {statusGroups} from '../../../domain/merge-manager/status';
import type {StatusGroup, StatusGroupId, StatusItem, StatusTone} from '../../../domain/merge-manager/status';
import {pullRequestPageRef, samePullRequest} from '../../../domain/session-work/pull-request-link';
import type {PullRequestRef} from '../../../domain/session-work/pull-request-link';
import type {MainAreaRoute} from '../../state/main-area-slice';
import type {SessionWorkPage} from '../../state/session-work-slice';
import {byRepository} from '../merge-manager/status-view';

/** Whether a row offers Land it: always shown (ready), shown under the pointer or cursor, or not at all. */
export type RowLand = 'ready' | 'offered' | null;

export interface PullRequestListRow {
    /** `landedKey`: the same whether it is landed or not. */
    readonly key: string;
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly group: StatusGroupId;
    /** The status dot's colour: its group's. */
    readonly tone: StatusTone;
    /** "#523 · Ready to land". */
    readonly subline: string;
    /** The whole of where it stands, for a tooltip. */
    readonly hint: string;
    readonly land: RowLand;
    readonly draft: boolean;
    /** The not landed PR, which Land it hands over; null for a landed one. */
    readonly open: OpenPullRequest | null;
}

export interface PullRequestListRepo {
    /** `owner/repo`. */
    readonly repository: string;
    /** "switchboard". */
    readonly name: string;
    readonly rows: readonly PullRequestListRow[];
}

/** What the list draws in place of rows. */
export type PullRequestListState = 'rows' | 'loading' | 'empty' | 'failed';

/**
 * Your open PRs by repository. `open` is main's last read of them (null
 * before the first): the landed ones are left out of it, the lanes say
 * where those stand.
 */
export function pullRequestList(
    merge: MergeManagerState,
    open: readonly OpenPullRequest[] | null,
): PullRequestListRepo[] {
    const lanes = pageLanes(merge);
    const groups = statusGroups(lanes, notLanded(open ?? [], merge));
    const items = groups.flatMap((group) => group.items.map((item) => ({item, group})));
    const groupOf = new Map(items.map(({item, group}) => [item.key, group]));
    return byRepository(
        items.map(({item}) => item),
        lanes,
    ).map((repo) => ({
        repository: repo.repository,
        name: repo.name,
        rows: repo.items.map((item) => listRow(item, groupOf.get(item.key)!)),
    }));
}

function listRow(item: StatusItem, group: StatusGroup): PullRequestListRow {
    const {repository, number, title, url} = item.kind === 'lane' ? item.row : item.pr;
    const said = itemWords(item, group);
    return {
        key: item.key,
        repository,
        number,
        title,
        url,
        group: group.id,
        tone: group.tone,
        subline: `#${number} · ${said.words}`,
        hint: said.hint,
        land: item.kind === 'notLanded' && canLand(item.pr) ? (group.id === 'ready' ? 'ready' : 'offered') : null,
        draft: item.kind === 'notLanded' && item.pr.isDraft,
        open: item.kind === 'notLanded' ? item.pr : null,
    };
}

/**
 * Where it stands, in the Merge manager's words: a landed PR's stage words
 * ("Landed · 2nd", "Held · @ana", "Needs you"; the head's step, "Head ·
 * checks"), a not landed one's pill ("Checks failing", "In review"), but
 * "Ready to land" for an approved and green one, the group it is in.
 */
function itemWords(item: StatusItem, group: StatusGroup): {words: string; hint: string} {
    if (item.kind === 'lane') {
        const {row} = item;
        const stage = row.stage.kind === 'head' ? rowStageLabel(row) : row.words.label;
        return {words: row.words.flag ? `${stage} · ${row.words.flag}` : stage, hint: row.words.title};
    }
    const status = notLandedStatus(item.pr);
    const label = notLandedLabel(status);
    return {words: status === 'ready' ? group.name : label, hint: `Not landed: ${label.toLowerCase()}`};
}

/** Every row's key, top to bottom: where the cursor goes. */
export function listKeys(repos: readonly PullRequestListRepo[]): string[] {
    return repos.flatMap((repo) => repo.rows.map((row) => row.key));
}

/** The row with `key`; null when it is not in the list. */
export function findListRow(repos: readonly PullRequestListRepo[], key: string | null): PullRequestListRow | null {
    if (!key) return null;
    for (const repo of repos) {
        const row = repo.rows.find((candidate) => candidate.key === key);
        if (row) return row;
    }
    return null;
}

/**
 * ↑ or ↓ from `current`: the next row, stopping at either end. From
 * nowhere (or a row that is gone), ↓ starts at the top and ↑ at the bottom.
 */
export function stepListKey(keys: readonly string[], current: string | null, step: 1 | -1): string | null {
    if (keys.length === 0) return null;
    const at = current === null ? -1 : keys.indexOf(current);
    if (at === -1) return step === 1 ? keys[0] : keys[keys.length - 1];
    return keys[Math.min(keys.length - 1, Math.max(0, at + step))];
}

/** Where the cursor starts as the list takes the keys: on the PR on screen, else the first row. */
export function startListKey(repos: readonly PullRequestListRepo[], onScreen: string | null): string | null {
    const keys = listKeys(repos);
    return onScreen && keys.includes(onScreen) ? onScreen : (keys[0] ?? null);
}

/** What the list shows besides rows: loading before the first read, empty, or that the read failed. */
export function listState(
    rows: number,
    read: {readonly hasRead: boolean; readonly failed: boolean},
): PullRequestListState {
    if (rows > 0) return 'rows';
    if (read.failed) return 'failed';
    return read.hasRead ? 'empty' : 'loading';
}

/**
 * The PR the main area shows: a PR's own work page, or a session's work
 * page on one of its PRs (the one a link asked for until a snapshot has
 * it, then the selected item). Null for anything else.
 */
export function pullRequestOnScreen(route: MainAreaRoute, page: SessionWorkPage | null): PullRequestRef | null {
    if (route.kind !== 'sessionWork' || page?.sessionId !== route.sessionId) return null;
    const own = pullRequestPageRef(page.sessionId);
    if (own) return own;
    if (page.wantedPullRequest) return page.wantedPullRequest;
    const item = page.snapshot?.items.find((candidate) => candidate.id === page.selectedItemId);
    return item?.kind === 'pr' ? {repository: item.pr.repository, number: item.pr.number} : null;
}

/** The key of the row whose PR the main area shows; null when none of them is. */
export function onScreenKey(repos: readonly PullRequestListRepo[], onScreen: PullRequestRef | null): string | null {
    if (!onScreen) return null;
    for (const repo of repos) {
        const row = repo.rows.find((candidate) => samePullRequest(candidate, onScreen));
        if (row) return row.key;
    }
    return null;
}

/** What a key asks of the list. */
export type PullRequestListKey = 'down' | 'up' | 'open' | 'land' | 'github' | 'leave';

/**
 * The list's keys: the arrows or J and K step, Enter opens the PR, L lands
 * it, O opens it on GitHub and Escape lets go. The letters are left alone
 * with Cmd, Ctrl or Alt held (and with Shift), so chords stay the app's.
 */
export function pullRequestListKey(e: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
}): PullRequestListKey | null {
    const chord = e.metaKey || e.ctrlKey || e.altKey;
    switch (e.key) {
        case 'ArrowDown':
            return chord ? null : 'down';
        case 'ArrowUp':
            return chord ? null : 'up';
        case 'Enter':
            return chord ? null : 'open';
        case 'Escape':
            return 'leave';
    }
    if (chord || e.shiftKey) return null;
    switch (e.key) {
        case 'j':
            return 'down';
        case 'k':
            return 'up';
        case 'l':
            return 'land';
        case 'o':
            return 'github';
        default:
            return null;
    }
}
