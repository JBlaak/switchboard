/**
 * What the session tray (#343) says, worked out from what it was told: the
 * Session group's numbers, each link row's meta line, which links it lists,
 * the facts a saved prompt is filled from, and the ⌘ keys its PRs open
 * with. Pure, so it is tested in node.
 */
import {LINKS_GITHUB_TTL_MS, type LinkedPr, type SessionLink} from '../../../domain/session/links';
import {pullRequestLabel} from '../../../domain/session/pull-requests';
import type {SessionPullRequest} from '../../../domain/session/session';
import {freshnessText} from '../shared/freshness-text';
import type {SessionStats} from '../../../domain/session/stats';
import {SAVED_PROMPT_KEYS} from '../../../domain/settings/saved-prompts';
import type {SavedPromptFacts} from '../../../domain/settings/saved-prompts';
import type {StatusDot} from '../../../domain/session-work/status';

/** The context used as a whole percentage, or null when nothing has reported usage. */
export function contextPercent(contextUsed: number | null | undefined): number | null {
    if (contextUsed === null || contextUsed === undefined || !Number.isFinite(contextUsed)) return null;
    return Math.round(Math.min(1, Math.max(0, contextUsed)) * 100);
}

/** How long the session has run: `12m`, `1h 12m`, `2d 3h`; null when its start is unknown. */
export function runningTimeLabel(startedAt: string | null | undefined, now: number): string | null {
    if (!startedAt) return null;
    const started = Date.parse(startedAt);
    if (!Number.isFinite(started)) return null;
    const minutes = Math.max(0, Math.floor((now - started) / 60_000));
    if (minutes < 60) return minutes + 'm';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The Session group's meta line: shell · running time · messages, each left out when unknown. */
export function sessionMetaLine(stats: SessionStats | null, now: number): string {
    if (!stats) return '';
    const parts: string[] = [];
    if (stats.shell) parts.push(stats.shell);
    const running = runningTimeLabel(stats.startedAt, now);
    if (running) parts.push(running);
    if (stats.messageCount !== null) parts.push(stats.messageCount + (stats.messageCount === 1 ? ' msg' : ' msgs'));
    return parts.join(' · ');
}

/** How long ago, roughly: `just now`, `2m ago`, `3h ago`, `4d ago`. */
export function agoLabel(at: number, now: number): string {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
}

/** The dot a link's chip carries: a PR's status (as the sidebar's chip), or its kind's colour. */
export type LinkDot = StatusDot | 'issue' | 'artifact' | 'page' | 'bug' | 'task';

/** A link row's second line: the chip (dot and label) and the words after it. */
export interface LinkMeta {
    readonly dot: LinkDot | null;
    readonly chip: string;
    readonly text: string;
}

/** What a link row says under its title. `now` dates a page. */
export function linkMeta(link: SessionLink, now: number): LinkMeta {
    switch (link.kind) {
        case 'pr':
            return {dot: link.status?.dot ?? null, chip: '#' + link.number, text: prStateText(link.status)};
        case 'issue':
            return {dot: 'issue', chip: '#' + link.number, text: link.status === 'closed' ? 'closed issue' : 'issue'};
        case 'artifact':
            return {dot: 'artifact', chip: 'artifact', text: 'claude.ai'};
        case 'page':
            return {dot: 'page', chip: 'page', text: link.shownAt === null ? '' : agoLabel(link.shownAt, now)};
        case 'bug':
            return {dot: 'bug', chip: 'bugsnag', text: link.project};
        case 'task':
            return {dot: 'task', chip: 'task', text: link.status ?? ''};
    }
}

function prStateText(status: Extract<SessionLink, {kind: 'pr'}>['status']): string {
    if (!status) return '';
    if (status.state !== 'open') return status.state;
    switch (status.checks) {
        case 'passing':
            return 'checks green';
        case 'pending':
            return 'checks running';
        case 'failing':
            return 'checks failing';
        case 'none':
            return 'open';
    }
}

/** A PR's status this old (two of the links' `gh` intervals) is worth a word in the tray. */
export const TRAY_STALE_PR_MS = 2 * LINKS_GITHUB_TTL_MS;

/**
 * How fresh a PR link's status is, only when it matters in the compact tray:
 * the last read failed, GitHub's reads are held back (`heldUntil` in the
 * future), or it is older than {@link TRAY_STALE_PR_MS}. Null otherwise, and
 * for anything that is not a PR with a status from the links' own read.
 */
export function prFreshness(link: SessionLink, now: number, heldUntil: number | null): string | null {
    if (link.kind !== 'pr' || !link.read) return null;
    const {fetchedAt, failed} = link.read;
    const held = heldUntil !== null && heldUntil > now;
    const old = fetchedAt !== null && now - fetchedAt > TRAY_STALE_PR_MS;
    if (!failed && !held && !old) return null;
    return freshnessText({fetchedAt, failed}, now, heldUntil);
}

/** The page this window keeps for the session (`pages-slice`): its latest, the only one a row can bring back. */
export interface KeptPage {
    readonly title: string;
    readonly shownAt: number;
}

/** One row of the Links group: the link, and whether a click can do anything with it. */
export interface TrayLink {
    readonly link: SessionLink;
    /** False for a page this window no longer has (shown before a restart). */
    readonly opens: boolean;
}

/**
 * The links the tray lists: every one but the pages before the newest. The
 * renderer only keeps a session's latest page, so that is the one a page row
 * can bring back; one main has not read off the transcript yet is added from
 * what the renderer keeps.
 */
export function trayLinks(links: readonly SessionLink[], kept: KeptPage | null): TrayLink[] {
    const rows: TrayLink[] = [];
    let page = false;
    for (const link of links) {
        if (link.kind !== 'page') {
            rows.push({link, opens: true});
            continue;
        }
        if (page) continue;
        page = true;
        rows.push({link, opens: kept !== null});
    }
    if (!page && kept) {
        const at = rows.findIndex((row) => row.link.kind === 'task');
        const row: TrayLink = {
            link: {kind: 'page', key: 'page:kept', title: kept.title, id: 'kept', shownAt: kept.shownAt, status: null},
            opens: true,
        };
        if (at === -1) rows.push(row);
        else rows.splice(at, 0, row);
    }
    return rows;
}

/** The newest PR's URL, for `{pr}`; the list gives PRs newest first. */
export function newestPullRequestUrl(links: readonly SessionLink[]): string | null {
    for (const link of links) if (link.kind === 'pr') return link.url;
    return null;
}

/** What a saved prompt is filled from: the branch, the project's label, the task's title and the newest PR. */
export function promptFacts(facts: {
    branch: string | null | undefined;
    project: string | null | undefined;
    task: string | null | undefined;
    links: readonly SessionLink[];
}): SavedPromptFacts {
    const taskLink = facts.links.find((link) => link.kind === 'task');
    return {
        branch: facts.branch ?? null,
        project: facts.project ?? null,
        task: facts.task ?? (taskLink && taskLink.status !== null ? taskLink.title : null),
        pr: newestPullRequestUrl(facts.links),
    };
}

/**
 * The ⌘ keys the Links group's PRs open with: numbered on from the saved
 * prompts' keys, in the order the PRs are listed, while keys up to ⌘9 last.
 * Keyed by the link's key.
 */
export function pullRequestKeys(
    prompts: readonly {readonly key: number | null}[],
    links: readonly SessionLink[],
): Map<string, number> {
    let next = 1;
    for (const prompt of prompts) if (prompt.key !== null) next = Math.max(next, prompt.key + 1);
    const keys = new Map<string, number>();
    for (const link of links) {
        if (link.kind !== 'pr') continue;
        if (next > SAVED_PROMPT_KEYS) break;
        keys.set(link.key, next++);
    }
    return keys;
}

/** The PR ⌘`key` opens, if any. */
export function pullRequestForKey(
    prompts: readonly {readonly key: number | null}[],
    links: readonly SessionLink[],
    key: number,
): Extract<SessionLink, {kind: 'pr'}> | null {
    const keys = pullRequestKeys(prompts, links);
    for (const link of links) if (link.kind === 'pr' && keys.get(link.key) === key) return link;
    return null;
}

/**
 * The PRs the Links group lists before main's first answer for the session:
 * the ones its sidebar row already read off the transcript, newest first as
 * main lists them, each as the last answer had it (with GitHub's title and
 * status) where there was one, else as `owner/repo#12` without a status.
 */
export function seededPullRequests(
    rowPullRequests: readonly SessionPullRequest[],
    known: readonly LinkedPr[],
): LinkedPr[] {
    const byUrl = new Map(known.map((pr) => [pr.url, pr]));
    // Newest by where each was first linked, as main orders them.
    const first = new Map<string, SessionPullRequest>();
    for (const pr of rowPullRequests) if (!first.has(pr.url)) first.set(pr.url, pr);
    const prs: LinkedPr[] = [];
    for (const pr of [...first.values()].reverse()) {
        prs.push(
            byUrl.get(pr.url) ?? {
                kind: 'pr',
                key: 'pr:' + pr.url,
                title: pullRequestLabel(pr),
                url: pr.url,
                repository: pr.repository,
                number: pr.number,
                status: null,
            },
        );
    }
    return prs;
}
