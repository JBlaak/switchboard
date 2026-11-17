/**
 * The Bug manager page (#414, for #409), renderer side: the Bug manager's
 * items as main last answered them, the tab and filter, the cursor, and
 * what the detail pane and the rows' sparklines read from Bugsnag.
 *
 * **Tabs.** Inbox (unread and read), In progress, Done, Snoozed, Backlog,
 * each with its count. Only Needs you and CI failing put a dot on In progress.
 *
 * **Filters.** Over the inbox: Unread, Trending, Regressed and New. The same
 * filter again shows the whole inbox.
 *
 * **Groups.** The rows are grouped by the local project their Bugsnag project
 * is linked to ("from Connect API + Connect Web"), and the projects linked to
 * none in "Not linked", last. Within a group unread rows come first, then
 * urgent ones, then the most recently seen. The cursor walks the rows in that
 * order. A row the cursor marks seen keeps its unread place, under the
 * Unread filter too, until the tab or filter changes or the page opens again:
 * otherwise J/K would push each row it lands on down below the unread ones,
 * and the next step would skip rows.
 */
import type {BugDetail} from '../../application/services/bug-fix-service';
import type {SnoozeOptionView} from '../../application/services/inbox-settings-service';
import type {BugsnagProjectSetting} from '../../domain/bugsnag/connection';
import type {InboxItem} from '../../domain/inbox/model';
import {isUrgent} from '../../domain/inbox/model';
import {wantsYou} from '../../domain/inbox/stage';
import {tabOf, type InboxTab} from '../../domain/inbox/tabs';
import type {RendererEvent} from './events';

/** The page's tabs are the managers' own (`domain/inbox/tabs`). */
export type BugTab = InboxTab;
export type BugFilter = 'all' | 'unread' | 'trending' | 'regressed' | 'new';

export interface BugPageState {
    readonly items: readonly InboxItem[];
    /** The Bugsnag projects as Settings keeps them: names and local links. */
    readonly projects: readonly BugsnagProjectSetting[];
    /** When main last polled Bugsnag; null before it did. */
    readonly polledAt: number | null;
    readonly loaded: boolean;
    readonly tab: BugTab;
    readonly filter: BugFilter;
    /** The row under the cursor, by key; null for the first row. */
    readonly cursor: string | null;
    /** Rows marked seen on this visit, by key: they keep their unread place until the tab or filter changes. */
    readonly seenHere: readonly string[];
    readonly details: Readonly<Record<string, BugDetail>>;
    readonly trends: Readonly<Record<string, readonly number[]>>;
    /** The snooze menu, open on a row; options null while they load. */
    readonly snooze: {readonly key: string; readonly options: readonly SnoozeOptionView[] | null} | null;
    /** A Fix being prepared and launched. */
    readonly fixing: string | null;
    /** A quick triage (T) being started. */
    readonly triaging: string | null;
    /** One line about the last thing that went wrong; null when nothing did. */
    readonly notice: string | null;
}

export type BugPageEvent =
    | {type: 'bugPageOpened'}
    | {type: 'bugPageClosed'}
    | {
          type: 'bugPageLoaded';
          items: readonly InboxItem[];
          projects: readonly BugsnagProjectSetting[];
          polledAt: number | null;
      }
    | {type: 'bugItemChanged'; item: InboxItem}
    | {type: 'bugTabChosen'; tab: BugTab}
    | {type: 'bugFilterChosen'; filter: BugFilter}
    | {type: 'bugCursorMoved'; key: string | null}
    | {type: 'bugDetailLoaded'; key: string; detail: BugDetail}
    | {type: 'bugTrendLoaded'; key: string; trend: readonly number[]}
    | {type: 'bugSnoozeOpened'; key: string; options: readonly SnoozeOptionView[] | null}
    | {type: 'bugSnoozeClosed'}
    | {type: 'bugFixing'; key: string | null}
    | {type: 'bugTriaging'; key: string | null}
    | {type: 'bugPageNoticed'; notice: string | null};

export const initialBugPageState: BugPageState = {
    items: [],
    projects: [],
    polledAt: null,
    loaded: false,
    tab: 'inbox',
    filter: 'all',
    cursor: null,
    seenHere: [],
    details: {},
    trends: {},
    snooze: null,
    fixing: null,
    triaging: null,
    notice: null,
};

export function bugPageReducer(state: BugPageState, event: RendererEvent): BugPageState {
    switch (event.type) {
        // A fresh look each time: the inbox, unfiltered, from the top. What Bugsnag said stays.
        // The figure on the empty screen opens it too (#416), just as fresh.
        case 'bugPageOpened':
            return {...state, tab: 'inbox', filter: 'all', cursor: null, seenHere: [], snooze: null, notice: null};
        case 'managerPageRequested':
            return event.manager === 'bug'
                ? {...state, tab: 'inbox', filter: 'all', cursor: null, seenHere: [], snooze: null, notice: null}
                : state;
        case 'bugPageClosed':
            return state.snooze ? {...state, snooze: null} : state;
        case 'bugPageLoaded':
            return {...state, items: event.items, projects: event.projects, polledAt: event.polledAt, loaded: true};
        case 'bugItemChanged': {
            const at = state.items.findIndex((item) => item.key === event.item.key);
            if (at < 0) return {...state, items: [...state.items, event.item]};
            const items = [...state.items];
            items[at] = event.item;
            return {...state, items};
        }
        case 'bugTabChosen':
            return {...state, tab: event.tab, filter: 'all', cursor: null, seenHere: [], snooze: null};
        case 'bugFilterChosen':
            return {
                ...state,
                tab: 'inbox',
                filter: state.tab === 'inbox' && state.filter === event.filter ? 'all' : event.filter,
                cursor: null,
                seenHere: [],
                snooze: null,
            };
        case 'bugCursorMoved': {
            if (state.cursor === event.key) return state;
            const lands = state.items.find((item) => item.key === event.key);
            const seenHere =
                lands?.state.kind === 'unread' && !state.seenHere.includes(lands.key)
                    ? [...state.seenHere, lands.key]
                    : state.seenHere;
            return {...state, cursor: event.key, seenHere, snooze: null};
        }
        case 'bugDetailLoaded':
            return {...state, details: {...state.details, [event.key]: event.detail}};
        case 'bugTrendLoaded':
            return {...state, trends: {...state.trends, [event.key]: event.trend}};
        case 'bugSnoozeOpened':
            return {...state, snooze: {key: event.key, options: event.options}};
        case 'bugSnoozeClosed':
            return state.snooze ? {...state, snooze: null} : state;
        case 'bugFixing':
            return {...state, fixing: event.key};
        case 'bugTriaging':
            return {...state, triaging: event.key};
        case 'bugPageNoticed':
            return {...state, notice: event.notice};
        default:
            return state;
    }
}

// ── What the page shows ──

/** Whether a Fix in progress wants you (Needs you, CI failing): the In progress tab's dot. */
export function inProgressWantsYou(items: readonly InboxItem[]): boolean {
    return items.some((item) => item.state.kind === 'inProgress' && wantsYou(item.state.stage));
}

type RowsOf = Pick<BugPageState, 'items' | 'projects' | 'tab' | 'filter'> & Partial<Pick<BugPageState, 'seenHere'>>;

/** Unread, or marked seen on this visit and so still in its unread place. */
function unreadHere(item: InboxItem, seenHere: ReadonlySet<string>): boolean {
    return item.state.kind === 'unread' || (item.state.kind === 'read' && seenHere.has(item.key));
}

function passes(item: InboxItem, filter: BugFilter, seenHere: ReadonlySet<string>): boolean {
    switch (filter) {
        case 'all':
            return true;
        case 'unread':
            return unreadHere(item, seenHere);
        case 'trending':
            return item.signals?.trending === true;
        case 'regressed':
            return item.signals?.regressed === true;
        case 'new':
            return item.signals?.new === true;
    }
}

export interface BugGroup {
    /** The local project's path; null for the "Not linked" group. */
    readonly projectPath: string | null;
    readonly title: string;
    /** The Bugsnag projects its rows come from, by name. */
    readonly sources: readonly string[];
    readonly rows: readonly InboxItem[];
}

/** A local project's name: its folder. */
export function projectTitle(projectPath: string): string {
    return projectPath.replace(/\/+$/, '').split('/').pop() || projectPath;
}

/** A Bugsnag project's name as Settings knows it, else its id. */
export function sourceName(projects: readonly BugsnagProjectSetting[], projectId: string): string {
    return projects.find((project) => project.id === projectId)?.name || projectId;
}

/** The rows of the tab, filtered, grouped by local project with "Not linked" last. */
export function bugGroups(state: RowsOf): BugGroup[] {
    const seenHere = new Set(state.seenHere ?? []);
    const linkOf = new Map(state.projects.map((project) => [project.id, project.localProject]));
    const groups = new Map<string | null, InboxItem[]>();
    for (const item of state.items) {
        if (tabOf(item.state) !== state.tab || (state.tab === 'inbox' && !passes(item, state.filter, seenHere)))
            continue;
        const projectPath = linkOf.get(item.source) ?? null;
        const rows = groups.get(projectPath) ?? [];
        rows.push(item);
        groups.set(projectPath, rows);
    }
    return [...groups.entries()]
        .map(([projectPath, rows]) => ({
            projectPath,
            title: projectPath ? projectTitle(projectPath) : 'Not linked',
            sources: [...new Set(rows.map((row) => sourceName(state.projects, row.source)))].sort(),
            rows: rows.sort((a, b) => rowOrder(a, b, seenHere)),
        }))
        .sort((a, b) => (a.projectPath === null ? 1 : b.projectPath === null ? -1 : a.title.localeCompare(b.title)));
}

/** Unread first, then urgent, a done item asking about events after its merge first, then the most recently seen. */
function rowOrder(a: InboxItem, b: InboxItem, seenHere: ReadonlySet<string>): number {
    const rank = (item: InboxItem): number =>
        (unreadHere(item, seenHere) ? 0 : 4) + (isUrgent(item) ? 0 : 2) + (item.fix?.seenAgain ? 0 : 1);
    return rank(a) - rank(b) || lastSeen(b) - lastSeen(a);
}

function lastSeen(item: InboxItem): number {
    const at = item.facts.kind === 'bug' ? Date.parse(item.facts.lastSeen) : NaN;
    return Number.isFinite(at) ? at : 0;
}

/** Every row on the page, in the order the cursor walks them. */
export function bugRows(state: RowsOf): InboxItem[] {
    return bugGroups(state).flatMap((group) => group.rows);
}

/** The row under the cursor: the one it names, else the first. */
export function bugCursorRow(state: BugPageState): InboxItem | null {
    const rows = bugRows(state);
    return rows.find((row) => row.key === state.cursor) ?? rows[0] ?? null;
}

/** The key of the row `step` rows from the cursor's, held at both ends. */
export function steppedBugCursor(state: BugPageState, step: 1 | -1): string | null {
    const rows = bugRows(state);
    if (rows.length === 0) return null;
    const at = rows.findIndex((row) => row.key === bugCursorRow(state)?.key);
    return rows[Math.min(rows.length - 1, Math.max(0, at + step))]!.key;
}
