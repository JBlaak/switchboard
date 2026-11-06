/**
 * What the session tray (#343) says, worked out from what it was told: the
 * Session group's numbers, each link row's meta line, which links it lists,
 * and the facts a saved prompt is filled from. Pure, so it is tested in node.
 */
import type {SessionLink} from '../../../domain/session/links';
import type {SessionStats} from '../../../domain/session/stats';
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
export type LinkDot = StatusDot | 'issue' | 'artifact' | 'page' | 'task';

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
