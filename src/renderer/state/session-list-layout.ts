/**
 * What the session list shows, and in what order: the rules, as pure
 * functions.
 *
 * One flat list across every project, never grouped by directory. Sessions
 * waiting on the user sort to the top, then the ones that finished unread, then
 * the ones still working, then pinned, then the rest — each block most recent
 * first, except Working, which is newest *started* first (see `sortKey`).
 * Sessions sharing a slug fold into a group, but only within their own project.
 * A plan the user pinned (such a group, or a GitHub plan pinned from its
 * page) sits above all of them, and a project pinned from its page above that.
 *
 * The list is *anchored*: the session the user is working in keeps the slot it
 * already had, so the list cannot slide out from under the cursor while the
 * rest reorders. That needs the order the list was last laid out in, which the
 * session-list slice keeps and hands back here (see `session-list-slice`).
 *
 * Nothing here reads the DOM, the store or the clock: the caller passes in
 * everything that is live (the tiers, the keys, the time), so each rule can be
 * tested in node with a plain record.
 */
import {byMostRecentlyModified} from '../../domain/session/session';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {isSnoozed} from '../../domain/session/snooze';
import {cleanDisplayName} from '../../domain/session/title';
import {
    TIER_ATTENTION,
    TIER_ORDER,
    TIER_REST,
    TIER_RUNNING,
    itemTier,
    rowSurvivesTruncation,
} from '../../domain/session/tiers';
import {formatDate, localDateKey} from '../lib/format';
import type {Project} from '../../domain/project/project';
import type {ErrandEntry} from '../../domain/session/errand-shelf';
import type {SessionRow} from '../../domain/session/session';
import type {WorkingAgent} from '../../domain/terminal/program-status-children';

/** One session's row, with the copy of the session it was laid out from. */
export interface SessionListRow {
    readonly kind: 'row';
    /** `si-<local key>`: stable across a re-key, so the row keeps its element. */
    readonly id: string;
    readonly session: SessionRow;
    /** The project it is listed under; its own path when that is empty. */
    readonly projectPath: string;
}

/** Sessions sharing a slug, newest first. */
export interface SessionListGroup {
    readonly kind: 'group';
    /** See `slugId`. */
    readonly id: string;
    readonly slug: string;
    readonly projectPath: string;
    readonly sessions: readonly SessionListRow[];
}

/** A GitHub plan pinned from its page: a row that opens the page, with no sessions of its own. */
export interface SessionListPlan {
    readonly kind: 'plan';
    /** See `planPinId`. */
    readonly id: string;
    readonly projectPath: string;
    readonly repository: string;
    readonly number: number;
    readonly title: string;
}

/** A project pinned from its page: a row that opens the page; its sessions stay in their own sections. */
export interface SessionListProject {
    readonly kind: 'project';
    /** See `projectPinId`. */
    readonly id: string;
    readonly projectPath: string;
}

export type SessionListEntry = SessionListRow | SessionListGroup | SessionListPlan | SessionListProject;

/** A top-level entry, with what the ordering rules need from it. */
export interface ListItem {
    readonly entry: SessionListEntry;
    /** Epoch ms of the newest session behind this entry. */
    readonly sortTime: number;
    /** Epoch ms the newest-started session behind this entry was started. */
    readonly startTime: number;
    readonly pinned: boolean;
    /** A plan pinned to the top of the list. */
    readonly pinnedPlan: boolean;
    /** A project pinned to the top of the list, above the plans. */
    readonly pinnedProject?: boolean;
    /** The highest tier of its sessions, before pinning is taken into account. */
    readonly tier: number;
    readonly remote: boolean;
    /**
     * A stuck errand's row in Blocked: it sits below every one of the user's
     * own entries there, whatever the anchoring does, and neither counts
     * toward the visible cap nor goes behind "older".
     */
    readonly errand?: boolean;
}

/** An entry in its final place, under the section it is filed in. */
export interface LaidEntry {
    readonly entry: SessionListEntry;
    readonly tier: number;
}

/** An errand's session on the Errands shelf. */
export interface LaidErrand {
    readonly entry: SessionListRow;
    readonly errand: ErrandEntry;
}

/** One entry of the full render order, the thing the next layout anchors against. */
export interface OrderedEntry {
    readonly id: string;
    readonly tier: number;
}

/** What the list shows: the visible entries, and what is behind "+ N older". */
export interface SessionListLayout {
    readonly visible: readonly LaidEntry[];
    readonly older: readonly LaidEntry[];
    /**
     * The Errands shelf, docked under the list: every errand's session, the
     * ones that need you first, then the rest newest started first. Empty
     * while filtering, when errands show inline among the matches.
     */
    readonly errands: readonly LaidErrand[];
    /** A filter or a search is on: no section labels, and nothing folded away. */
    readonly filtering: boolean;
}

// ── Labels and ids ──

/**
 * The element id for a slug group.
 *
 * The same slug can exist in two checkouts of the same repo; they stay two
 * groups, so the project has to be part of the id.
 */
export function slugId(slug: string, projectPath: string): string {
    return 'slug-' + (projectPath + '--' + slug).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The element id for a pinned GitHub plan's row; the same plan can be pinned in two projects. */
export function planPinId(projectPath: string, repository: string, number: number): string {
    return 'plan-' + (projectPath + '--' + repository + '--' + number).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The element id for a pinned project's row. */
export function projectPinId(projectPath: string): string {
    return 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The element id of a session's row. */
export function rowId(key: string): string {
    return 'si-' + key;
}

/**
 * The element id of a session's row on the Errands shelf. Not `rowId`: a
 * stuck errand shows both on the shelf and in Blocked, and the two rows are
 * two elements the cursor can be on.
 */
export function errandRowId(key: string): string {
    return 'er-' + key;
}

/** The label a session shows: its name, its AI title, or its first prompt. */
export function sessionDisplayName(session: SessionRow): string {
    return cleanDisplayName(session.name || session.aiTitle || session.summary) ?? '';
}

/** The label a slug group shows: its newest session's, falling back to the slug. */
export function groupDisplayName(group: SessionListGroup): string {
    const newest = group.sessions[0].session;
    return cleanDisplayName(newest.name || newest.aiTitle || newest.summary || group.slug) ?? '';
}

/** The name a session shows when it has no rename of its own — what a rename falls back to. */
export function fallbackName(session: SessionRow): string {
    return session.aiTitle || session.summary;
}

/** The relative time, as of `now`. */
export function sessionTimeLabel(session: SessionRow, now: number): string {
    return formatDate(new Date(session.modified), now);
}

/** What the meta line says while the session is asking questions. */
export function askingLabel(count: number): string {
    return count === 1 ? 'Asking 1 question' : `Asking ${count} questions`;
}

/** The agents badge's tooltip: how many are working, and each one's task. */
export function agentsTitle(agents: readonly WorkingAgent[]): string {
    return (
        `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} working\n` +
        agents.map((agent) => '• ' + (agent.title || 'Untitled agent')).join('\n')
    );
}

/**
 * The name a rename stores for what was typed.
 *
 * Typing the fallback title back, or nothing at all, means "no rename" rather
 * than "rename to this": the name is cleared, and the row goes back to
 * following the CLI's own title.
 */
export function renamedName(typed: string, session: SessionRow): string | null {
    const value = typed.trim();
    return value && value !== fallbackName(session) ? value : null;
}

/**
 * Whether a row carries the terminal glyph: a terminal, local or remote, gets a
 * glyph rather than a word, because its label is already "Terminal".
 */
export function showsTerminalBadge(session: SessionRow): boolean {
    return session.type === 'terminal' || (session.type === 'remote' && session.remoteKind === 'shell');
}

/** The buttons a row offers, by their titles; `null` or `false` for one it leaves out. */
export interface RowButtons {
    readonly stop: string;
    readonly archive: string | null;
    /** Snoozing is keyed on the session id, like archiving; an archived row has nothing to snooze. */
    readonly snooze: boolean;
    readonly resume: boolean;
    /** Bring back (#276): a Claude session on a VM copy of a local project, the counterpart of Hand off to…. */
    readonly bringBack: boolean;
}

/**
 * Whether a session can be handed off to a VM: a local Claude session, never
 * a terminal or a session already on a remote or a VM, and only once there is
 * a host to hand it to.
 */
export function canHandOffSession(session: SessionRow, hosts: number): boolean {
    if (hosts <= 0) return false;
    if (session.type === 'terminal' || session.type === 'remote') return false;
    return !isRemoteProjectPath(session.projectPath);
}

/**
 * Whether a session can be brought back from a VM to this Mac: a Claude
 * session (never a terminal) on a VM project that is a hand-off copy of a
 * local one, which is where it comes back to.
 */
export function canBringBackSession(session: SessionRow, {vm, copy}: {vm: boolean; copy: boolean}): boolean {
    return vm && copy && session.type === 'remote' && session.remoteKind !== 'shell';
}

/**
 * Which buttons a row offers, depending on what the session actually supports.
 *
 * A remote session has no local transcript to relaunch from; archive still
 * works — it is keyed on the session id alone — and doubles as "forget this
 * one". A session on a VM (`vm`, #276) is the exception: it has one, on the
 * agent. A plain terminal has nothing to archive or resume either. Stop is
 * always there; the stylesheet shows it only while something runs. Bring back
 * is there for a Claude session on a VM `copy` of a local project. Hand off
 * to… is not a row button: it lives in the session tray and elsewhere.
 */
export function rowButtons(
    session: SessionRow,
    {vm = false, copy = false}: {vm?: boolean; copy?: boolean} = {},
): RowButtons {
    // A session on a VM (#276) runs on the agent as a local one does: stopping
    // it stops it, and a Claude session there resumes like one here.
    const disconnects = session.type === 'remote' && !vm;
    const shell = session.type === 'terminal' || (session.type === 'remote' && session.remoteKind === 'shell');
    return {
        stop: disconnects ? 'Disconnect (keeps running on the remote)' : 'Stop session',
        archive: session.type === 'terminal' ? null : session.archived ? 'Unarchive' : 'Archive',
        snooze: session.type !== 'terminal' && !session.archived,
        resume: !disconnects && !shell,
        bringBack: canBringBackSession(session, {vm, copy}),
    };
}

/**
 * A slug group's sessions split the way it renders them: the running ones
 * promoted to the top, the rest behind its "+ N more". Each part keeps the
 * group's newest-first order.
 */
export function splitGroupRows(
    sessions: readonly SessionListRow[],
    running: ReadonlySet<string>,
): {promoted: SessionListRow[]; rest: SessionListRow[]} {
    return {
        promoted: sessions.filter((r) => running.has(r.session.sessionId)),
        rest: sessions.filter((r) => !running.has(r.session.sessionId)),
    };
}

// ── Building ──

/** The filters, as the list reads them. */
export interface ListFilters {
    readonly showArchived: boolean;
    readonly showStarredOnly: boolean;
    readonly showRunningOnly: boolean;
    readonly showSnoozedOnly: boolean;
    readonly showTodayOnly: boolean;
    /** null = no search active; a search lists snoozed sessions too. */
    readonly searchMatchIds: ReadonlySet<string> | null;
}

/** The live facts building needs, handed in so building stays pure. */
export interface BuildInputs {
    readonly filters: ListFilters;
    /** Session ids with a live PTY. */
    readonly running: ReadonlySet<string>;
    readonly activeSessionId: string | null;
    /** The tier a session's own signals put it in. */
    tierOf(sessionId: string): number;
    /** A session's stable local key. */
    keyOf(sessionId: string): string;
    /** Today, as `localDateKey` spells it. */
    readonly today: string;
    /** The time, in ms: a snoozed session stays out of the list until its own. */
    readonly now: number;
    /** The errand a session runs (see `state/errand-index`), or null for one the user started. */
    errandOf(sessionId: string): ErrandEntry | null;
}

export function passesFilters(sessions: readonly SessionRow[], inputs: BuildInputs): SessionRow[] {
    const {filters} = inputs;
    let filtered = [...sessions];
    // The archive filter is the only way archived sessions surface: when it is on
    // we show exactly the archived ones, when it is off they are hidden entirely.
    if (filters.showArchived) filtered = filtered.filter((s) => s.archived);
    // A snoozed session is out of the list until its time, but its own filter
    // lists it, a search still finds it and the archive shows what it holds, so
    // it can be woken early.
    else if (filters.showSnoozedOnly) filtered = filtered.filter((s) => isSnoozed(s.snoozedUntil, inputs.now));
    else if (filters.searchMatchIds === null) filtered = filtered.filter((s) => !isSnoozed(s.snoozedUntil, inputs.now));
    if (filters.showStarredOnly) filtered = filtered.filter((s) => s.starred);
    if (filters.showRunningOnly) filtered = filtered.filter((s) => inputs.running.has(s.sessionId));
    if (filters.showTodayOnly) {
        filtered = filtered.filter((s) => s.modified && localDateKey(new Date(s.modified)) === inputs.today);
    }
    return filtered;
}

/**
 * Flatten every project's sessions into one list of entries.
 *
 * Sessions sharing a slug collapse into a group, but only within their own
 * project — the same slug in two checkouts stays two groups. Each session is
 * copied, so the layout holds what the list showed at this moment, however
 * the shared row objects change afterwards.
 */
export function listItems(
    projects: readonly Project[],
    inputs: BuildInputs,
): {items: ListItem[]; activeItemId: string | null; errands: LaidErrand[]} {
    const items: ListItem[] = [];
    const errands: LaidErrand[] = [];
    let activeItemId: string | null = null;

    const row = (session: SessionRow, projectPath: string): SessionListRow => ({
        kind: 'row',
        id: rowId(inputs.keyOf(session.sessionId)),
        session: {...session},
        projectPath,
    });

    // A pinned project or GitHub plan is a section of the unfiltered list
    // only: a filter or a search asks about sessions, and its row is none.
    const {filters} = inputs;
    const filtering =
        filters.showArchived ||
        filters.showStarredOnly ||
        filters.showRunningOnly ||
        filters.showSnoozedOnly ||
        filters.showTodayOnly ||
        filters.searchMatchIds !== null;

    for (const project of projects) {
        if (!filtering && project.pinnedAt !== undefined) {
            items.push({
                entry: {kind: 'project', id: projectPinId(project.projectPath), projectPath: project.projectPath},
                sortTime: project.pinnedAt,
                startTime: project.pinnedAt,
                pinned: false,
                pinnedPlan: false,
                pinnedProject: true,
                tier: TIER_REST,
                remote: false,
            });
        }
        if (!filtering) {
            for (const pin of project.pinnedIssuePlans ?? []) {
                items.push({
                    entry: {
                        kind: 'plan',
                        id: planPinId(project.projectPath, pin.repository, pin.number),
                        projectPath: project.projectPath,
                        repository: pin.repository,
                        number: pin.number,
                        title: pin.title,
                    },
                    sortTime: pin.pinnedAt,
                    startTime: pin.pinnedAt,
                    pinned: false,
                    pinnedPlan: true,
                    tier: TIER_REST,
                    remote: false,
                });
            }
        }

        let filtered = passesFilters(project.sessions, inputs);
        // Errands keep out of the user's sections: they go to the shelf, and
        // never join a slug group. While filtering they show inline among the
        // matches like any session, so the filter still finds them.
        if (!filtering) {
            filtered = filtered.filter((session) => {
                const errand = inputs.errandOf(session.sessionId);
                if (!errand) return true;
                if (session.archived) return false;
                const key = inputs.keyOf(session.sessionId);
                errands.push({
                    entry: {kind: 'row', id: errandRowId(key), session: {...session}, projectPath: project.projectPath},
                    errand,
                });
                if (errand.needsYou) {
                    // Stuck: only the user can move it on, so it also asks in Blocked.
                    const entry = row(session, project.projectPath);
                    if (session.sessionId === inputs.activeSessionId) activeItemId = entry.id;
                    items.push({
                        entry,
                        sortTime: new Date(session.modified).getTime(),
                        startTime: new Date(session.created).getTime(),
                        pinned: false,
                        pinnedPlan: false,
                        tier: TIER_ATTENTION,
                        remote: session.type === 'remote',
                        errand: true,
                    });
                }
                return false;
            });
        }
        if (filtered.length === 0) continue;

        const bySlug = new Map<string, SessionRow[]>();
        const ungrouped: SessionRow[] = [];
        for (const session of filtered) {
            if (!session.slug) {
                ungrouped.push(session);
                continue;
            }
            const group = bySlug.get(session.slug);
            if (group) group.push(session);
            else bySlug.set(session.slug, [session]);
        }

        for (const session of ungrouped) {
            const entry = row(session, project.projectPath);
            if (session.sessionId === inputs.activeSessionId) activeItemId = entry.id;
            items.push({
                entry,
                sortTime: new Date(session.modified).getTime(),
                startTime: new Date(session.created).getTime(),
                pinned: !!session.starred,
                pinnedPlan: false,
                tier: inputs.tierOf(session.sessionId),
                remote: session.type === 'remote',
            });
        }

        for (const [slug, sessions] of bySlug) {
            const sorted = [...sessions].sort(byMostRecentlyModified);
            // A pinned plan keeps its group header even with one session left, as
            // that is where the pin is.
            const pinnedPlan = !!project.pinnedPlans?.includes(slug);
            const entry: SessionListEntry =
                sorted.length === 1 && !pinnedPlan
                    ? row(sorted[0], project.projectPath)
                    : {
                          kind: 'group',
                          id: slugId(slug, project.projectPath),
                          slug,
                          projectPath: project.projectPath,
                          sessions: sorted.map((s) => row(s, project.projectPath)),
                      };
            if (sorted.some((s) => s.sessionId === inputs.activeSessionId)) activeItemId = entry.id;
            items.push({
                entry,
                sortTime: Math.max(...sorted.map((s) => new Date(s.modified).getTime())),
                startTime: Math.max(...sorted.map((s) => new Date(s.created).getTime())),
                pinned: sorted.some((s) => !!s.starred),
                pinnedPlan,
                tier: Math.max(...sorted.map((s) => inputs.tierOf(s.sessionId))),
                remote: sorted.some((s) => s.type === 'remote'),
            });
        }
    }

    return {items, activeItemId, errands};
}

// ── Ordering ──

/**
 * The time an entry is ordered by within its section.
 *
 * A working session writes to its transcript all the time, so its last
 * activity keeps moving and ordering Working by it reshuffled the block with
 * every write. When it was started never changes: the block stays put while
 * its sessions work, and a newly started one lands on top. The other sections
 * only change when a session lands in or leaves them, so recency suits them.
 */
function sortKey(item: ListItem, tier: number): number {
    return tier === TIER_RUNNING ? item.startTime : item.sortTime;
}

/**
 * Move the anchored entry back to the index it held last time, leaving
 * everything else in its freshly sorted order.
 */
function anchorToPreviousIndex(items: ListItem[], anchorId: string, previousIds: readonly string[]): void {
    const from = items.findIndex((item) => item.entry.id === anchorId);
    const to = previousIds.indexOf(anchorId);
    if (from === -1 || to === -1 || from === to) return;
    const [item] = items.splice(from, 1);
    items.splice(Math.min(to, items.length), 0, item);
}

/**
 * Sort the entries into their sections, newest first within each, with the
 * active entry anchored to its previous slot unless this is a re-sort.
 *
 * `previous` is the full order of the last layout (see `orderOf`).
 */
export function orderEntries(
    items: readonly ListItem[],
    activeItemId: string | null,
    resort: boolean,
    previous: readonly OrderedEntry[],
): LaidEntry[] {
    const buckets = new Map<number, ListItem[]>();
    for (const item of items) {
        const tier = itemTier(item);
        const bucket = buckets.get(tier);
        if (bucket) bucket.push(item);
        else buckets.set(tier, [item]);
    }

    const ordered: LaidEntry[] = [];
    for (const tier of TIER_ORDER) {
        const bucket = buckets.get(tier);
        if (!bucket) continue;
        bucket.sort((a, b) => sortKey(b, tier) - sortKey(a, tier));
        // Anchoring only holds while the session stays in the same block: once its
        // tier changes, the slot it used to occupy belongs to another section, and
        // holding it there would file the row under the wrong heading.
        if (!resort && activeItemId) {
            anchorToPreviousIndex(
                bucket,
                activeItemId,
                previous.filter((e) => e.tier === tier).map((e) => e.id),
            );
        }
        // A stuck errand asks below the user's own: theirs first, wherever anchoring left it.
        for (const item of bucket) if (!item.errand) ordered.push({entry: item.entry, tier});
        for (const item of bucket) if (item.errand) ordered.push({entry: item.entry, tier});
    }
    return ordered;
}

/** The caps truncation applies. */
export interface TruncationLimits {
    readonly visibleSessionCount: number;
    readonly sessionMaxAgeDays: number;
    /** Epoch ms the age cutoff counts back from. */
    readonly now: number;
}

/**
 * Split the list into what is shown and what is behind the "older" toggle.
 *
 * Never answers an empty visible list: if every row would be truncated, they
 * are all shown instead — an empty sidebar reads as a broken app.
 */
export function truncateEntries(
    ordered: readonly LaidEntry[],
    items: ReadonlyMap<string, ListItem>,
    activeItemId: string | null,
    {visibleSessionCount, sessionMaxAgeDays, now}: TruncationLimits,
): {visible: LaidEntry[]; older: LaidEntry[]} {
    const visible: LaidEntry[] = [];
    const older: LaidEntry[] = [];
    const ageCutoff = now - sessionMaxAgeDays * 86400000;
    let count = 0;

    for (const laid of ordered) {
        const item = items.get(laid.entry.id)!;
        // An errand is not one of the user's sessions: it takes no slot of theirs.
        if (item.errand) {
            visible.push(laid);
            continue;
        }
        const survives = rowSurvivesTruncation(item, laid.tier, {
            count,
            visibleSessionCount,
            ageCutoff,
            isActive: laid.entry.id === activeItemId,
        });
        if (survives) {
            visible.push(laid);
            count++;
        } else {
            older.push(laid);
        }
    }

    if (visible.length === 0 && older.length > 0) return {visible: older, older: []};
    return {visible, older};
}

/** Everything one layout pass needs besides the entries. */
export interface LayoutOptions extends TruncationLimits {
    readonly activeItemId: string | null;
    readonly resort: boolean;
    readonly filtering: boolean;
    /** The errands' sessions, in any order (see `listItems`); the shelf orders them. */
    readonly errands?: readonly LaidErrand[];
}

/** Order, then truncate — except while filtering, which shows every match. */
export function layoutSessionList(
    items: readonly ListItem[],
    previous: readonly OrderedEntry[],
    options: LayoutOptions,
): {layout: SessionListLayout; order: OrderedEntry[]} {
    const ordered = orderEntries(items, options.activeItemId, options.resort, previous);
    const byId = new Map(items.map((item) => [item.entry.id, item]));
    const {visible, older} = options.filtering
        ? {visible: ordered, older: []}
        : truncateEntries(ordered, byId, options.activeItemId, options);
    return {
        layout: {
            visible,
            older,
            errands: options.filtering ? [] : orderErrands(options.errands ?? []),
            filtering: options.filtering,
        },
        // The full order, folded rows included: a row coming back from "older"
        // anchors like any other.
        order: ordered.map(({entry, tier}) => ({id: entry.id, tier})),
    };
}

/**
 * The Errands shelf's order: the ones that need you first, then the rest
 * newest started first. Started, not last active: an errand writes to its
 * transcript all the time, and the shelf should hold still while it works.
 */
export function orderErrands(errands: readonly LaidErrand[]): LaidErrand[] {
    const started = (laid: LaidErrand): number => new Date(laid.entry.session.created).getTime();
    return [...errands].sort(
        (a, b) => Number(b.errand.needsYou) - Number(a.errand.needsYou) || started(b) - started(a),
    );
}

/**
 * Every row of a layout, inside groups, behind "older" and on the Errands
 * shelf included. A stuck errand is in it twice: its row in Blocked and its
 * row on the shelf, under their two ids.
 */
export function layoutRows(layout: SessionListLayout): SessionListRow[] {
    const rows: SessionListRow[] = [];
    for (const {entry} of [...layout.visible, ...layout.older]) {
        if (entry.kind === 'row') rows.push(entry);
        else if (entry.kind === 'group') rows.push(...entry.sessions);
    }
    for (const {entry} of layout.errands) rows.push(entry);
    return rows;
}
