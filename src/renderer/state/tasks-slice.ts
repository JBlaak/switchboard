/**
 * The Tasks page's state (#249): whether BlaakTasks is on at all, which of
 * its views the page shows (★ Today, In progress, Due, Quick or a search) for
 * Work or Private, the list as main last pushed it, the keyboard cursor, the
 * open task's detail, and how the last start from the page is going.
 *
 * BlaakTasks is on while a URL is set in Settings (#252). Off, the page, its
 * shortcut and its entry point are not there at all; the route gives way.
 *
 * The list itself is main's: the page watches one query (`tasksQuery`) under
 * its own watch id, and every poll (about a minute) or change pushes it back
 * as `tasksChanged`. An outage keeps the rows main last had, so the list stays
 * on screen under "Couldn't reach BlaakTasks · retrying".
 *
 * What each task is linked to in Switchboard (its repo and how many sessions
 * worked on it) is read from main's links, beside the rows.
 *
 * The project page's Tasks section (#251) shares the start, the detail, the
 * project list and the notice: one surface is on screen at a time.
 *
 * The events are declared here rather than in `events.ts`, like the project
 * page's, so the page's vocabulary stays in one file.
 */
import type { RendererEvent } from './events';
import type { RendererState } from './root';
import type { TaskContext, TaskDetail, TaskRow } from '../../domain/tasks/model';
import type { TaskQuery, TaskSessions, TaskSessionStart, TasksUpdate } from '../../domain/tasks/surface';

/** The page's views, as its tabs name them. */
export type TasksTab = 'today' | 'inProgress' | 'due' | 'quick' | 'search';

export const TASKS_TABS: readonly { readonly tab: TasksTab; readonly label: string }[] = [
  { tab: 'today', label: '★ Today' },
  { tab: 'inProgress', label: 'In progress' },
  { tab: 'due', label: 'Due' },
  { tab: 'quick', label: 'Quick' },
  { tab: 'search', label: 'Search' },
];

/** The id the page watches its list under (main's `watchTasks`). */
export const TASKS_PAGE_WATCH = 'tasks-page';

/** The list as main last pushed it for the page's query. */
export interface TasksList {
  /** `queryKey` of the query it answers. */
  readonly key: string;
  readonly state: TasksUpdate['state'];
  readonly rows: readonly TaskRow[];
  readonly reason: string | null;
  readonly fetchedAt: number | null;
}

/** What Switchboard has linked to the tasks: a task's repo, and how many sessions worked on it. */
export interface TaskLinks {
  readonly repos: Readonly<Record<string, string>>;
  readonly sessions: Readonly<Record<string, number>>;
}

/** The task open in the detail (Enter): what `getTask` answered, and its sessions. */
export interface TaskDetailView {
  readonly taskId: string;
  /** Null while it is being asked. */
  readonly detail: TaskDetail | null;
  readonly error: string | null;
  readonly sessions: TaskSessions | null;
}

/**
 * A start from the page (S): asked, then how it ended. `routed` names the
 * project Ask Patch picked for a task that had none ("Patch's line").
 * `picking` is the project list: "Other project…", no match, or Change repo.
 */
export type TasksStart =
  | { readonly taskId: string; readonly phase: 'starting' }
  | { readonly taskId: string; readonly phase: 'answered'; readonly outcome: TaskSessionStart; readonly routed: boolean };

/** The project list, open for a start (S) or for the detail's Change repo. */
export interface TasksPicker {
  readonly taskId: string;
  readonly purpose: 'start' | 'repo';
}

/** A quiet line after a key: what it did, or why it didn't. */
export interface TasksNotice {
  readonly text: string;
  readonly tone: 'info' | 'error';
}

export interface TasksState {
  /** A BlaakTasks URL is set: the page, its shortcut and its entry point exist. */
  readonly enabled: boolean;
  readonly tab: TasksTab;
  /** Work by default; Private one filter away. */
  readonly context: TaskContext;
  /** What the search tab looks for. */
  readonly search: string;
  readonly list: TasksList | null;
  /** The task id under the cursor. */
  readonly cursor: string | null;
  readonly links: TaskLinks;
  readonly detail: TaskDetailView | null;
  readonly start: TasksStart | null;
  readonly picker: TasksPicker | null;
  readonly notice: TasksNotice | null;
}

export const initialTasksState: TasksState = {
  enabled: false,
  tab: 'today',
  context: 'work',
  search: '',
  list: null,
  cursor: null,
  links: { repos: {}, sessions: {} },
  detail: null,
  start: null,
  picker: null,
  notice: null,
};

export type TasksPageEvent =
  /** The stored BlaakTasks URL, read at launch or saved in Settings: on when it is set. */
  | { type: 'blaakTasksSwitched'; on: boolean }
  /** The page takes the main area: its shortcut or its entry point. */
  | { type: 'tasksOpened' }
  /** Esc or Close: back to the session to return to, or the empty screen. */
  | { type: 'tasksClosed' }
  | { type: 'tasksTabChosen'; tab: TasksTab }
  | { type: 'tasksContextChosen'; context: TaskContext }
  | { type: 'tasksSearchTyped'; search: string }
  | { type: 'tasksCursorMoved'; taskId: string | null }
  | { type: 'tasksLinksLoaded'; links: TaskLinks }
  /** A key changed a task: its row as it is now, or null when it leaves the list (done, snoozed). */
  | { type: 'tasksRowChanged'; taskId: string; row: TaskRow | null }
  | { type: 'tasksNoticed'; notice: TasksNotice | null }
  | { type: 'tasksDetailOpened'; taskId: string }
  | { type: 'tasksDetailLoaded'; taskId: string; detail: TaskDetail | null; error: string | null; sessions: TaskSessions | null }
  | { type: 'tasksDetailClosed' }
  | { type: 'tasksStartAsked'; taskId: string }
  | { type: 'tasksStartAnswered'; taskId: string; outcome: TaskSessionStart; routed: boolean }
  /** The start's answer put away: another key, Esc, or a choice taken. */
  | { type: 'tasksStartDismissed' }
  | { type: 'tasksPickerOpened'; taskId: string; purpose: TasksPicker['purpose'] }
  | { type: 'tasksPickerClosed' };

export function tasksReducer(state: TasksState, event: RendererEvent): TasksState {
  switch (event.type) {
    case 'blaakTasksSwitched':
      if (event.on === state.enabled) return state;
      // Off forgets the list: switched on again, it is asked afresh.
      return event.on ? { ...state, enabled: true } : { ...initialTasksState };

    // A fresh look every time the page opens: the cursor on the first row,
    // nothing left open from last time. The view and filter stay as they were.
    case 'tasksOpened':
      return { ...state, cursor: null, detail: null, start: null, picker: null, notice: null };

    // The project page's Tasks section (#251) uses the same start, detail,
    // project list and notice for its rows: a page opening on a project
    // starts with none of them left over.
    case 'projectPageRestored':
      return state.detail || state.start || state.picker || state.notice
        ? { ...state, detail: null, start: null, picker: null, notice: null }
        : state;

    case 'tasksTabChosen':
      return state.tab === event.tab ? state : { ...state, tab: event.tab, cursor: null, notice: null };

    case 'tasksContextChosen':
      return state.context === event.context ? state : { ...state, context: event.context, cursor: null, notice: null };

    case 'tasksSearchTyped':
      return state.search === event.search ? state : { ...state, search: event.search, cursor: null };

    case 'tasksChanged': {
      const { update } = event;
      if (update.watchId !== TASKS_PAGE_WATCH) return state;
      const key = queryKey(update.query);
      // An answer to a query the page has moved on from.
      if (key !== currentKey(state)) return state;
      return {
        ...state,
        list: { key, state: update.state, rows: update.rows, reason: update.reason ?? null, fetchedAt: update.fetchedAt },
      };
    }

    case 'tasksCursorMoved':
      return state.cursor === event.taskId ? state : { ...state, cursor: event.taskId };

    case 'tasksLinksLoaded':
      return { ...state, links: event.links };

    case 'tasksRowChanged': {
      if (!state.list) return state;
      const rows = event.row
        ? state.list.rows.map(row => (row.id === event.taskId ? event.row! : row))
        : state.list.rows.filter(row => row.id !== event.taskId);
      // The cursor stays on the same spot when its row leaves.
      let cursor = state.cursor;
      if (!event.row && cursor === event.taskId) {
        const shown = visibleRows(state).map(row => row.id);
        const at = shown.indexOf(event.taskId);
        const left = shown.filter(id => id !== event.taskId);
        cursor = left.length ? left[Math.min(at, left.length - 1)] : null;
      }
      return { ...state, cursor, list: { ...state.list, rows } };
    }

    case 'tasksNoticed':
      return { ...state, notice: event.notice };

    case 'tasksDetailOpened':
      return { ...state, cursor: event.taskId, detail: { taskId: event.taskId, detail: null, error: null, sessions: null } };

    case 'tasksDetailLoaded':
      return state.detail?.taskId === event.taskId
        ? { ...state, detail: { taskId: event.taskId, detail: event.detail, error: event.error, sessions: event.sessions } }
        : state;

    case 'tasksDetailClosed':
      return state.detail ? { ...state, detail: null, picker: state.picker?.purpose === 'repo' ? null : state.picker } : state;

    case 'tasksStartAsked':
      return { ...state, start: { taskId: event.taskId, phase: 'starting' }, picker: null, notice: null };

    case 'tasksStartAnswered': {
      if (state.start?.taskId !== event.taskId) return state;
      const { outcome } = event;
      // No match: the project list, to pick from yourself.
      const picker: TasksPicker | null = outcome.kind === 'noMatch' ? { taskId: event.taskId, purpose: 'start' } : null;
      return { ...state, start: { taskId: event.taskId, phase: 'answered', outcome, routed: event.routed }, picker };
    }

    case 'tasksStartDismissed':
      return state.start?.phase === 'answered' ? { ...state, start: null, picker: state.picker?.purpose === 'start' ? null : state.picker } : state;

    case 'tasksPickerOpened':
      return { ...state, picker: { taskId: event.taskId, purpose: event.purpose } };

    case 'tasksPickerClosed':
      return state.picker ? { ...state, picker: null } : state;

    default:
      return state;
  }
}

// ── Reading it ──

/**
 * What the page asks BlaakTasks for: its view in its context, or the search.
 * In progress is the Today view (which lists what is in progress first) with
 * only those rows kept. A search with nothing typed asks nothing.
 */
export function tasksQuery(state: Pick<TasksState, 'tab' | 'context' | 'search'>): TaskQuery | null {
  const context = state.context;
  switch (state.tab) {
    case 'today':
    case 'inProgress':
      return { view: 'today', options: { context } };
    case 'due':
      return { view: 'due', options: { context } };
    case 'quick':
      return { view: 'quick', options: { context } };
    case 'search': {
      const query = state.search.trim();
      return query ? { view: 'today', options: { context, query } } : null;
    }
  }
}

/** One spelling of a query, to tell an answer to it from an answer to another. */
export function queryKey(query: TaskQuery): string {
  const { name, query: text, context, limit } = query.options ?? {};
  return JSON.stringify([query.view, name ?? null, text ?? null, context ?? null, limit ?? null]);
}

function currentKey(state: TasksState): string | null {
  const query = tasksQuery(state);
  return query ? queryKey(query) : null;
}

/** The list's rows for the page's view, or none while it has no answer to its query. */
export function visibleRows(state: TasksState): readonly TaskRow[] {
  const list = state.list;
  if (!list || list.key !== currentKey(state)) return [];
  return state.tab === 'inProgress' ? list.rows.filter(row => row.status === 'In progress') : list.rows;
}

/** Whether the list has an answer to the page's query yet. */
export function listAnswered(state: TasksState): boolean {
  return state.list !== null && state.list.key === currentKey(state);
}

/** The row under the cursor: the cursor's own, or the first while it is on none. */
export function cursorRow(state: TasksState): TaskRow | null {
  const rows = visibleRows(state);
  return rows.find(row => row.id === state.cursor) ?? rows[0] ?? null;
}

/** Whether the main area shows the Tasks page. */
export function tasksPageOpen(state: RendererState): boolean {
  return state.mainArea.route.kind === 'tasks';
}

/** `YYYY-MM-DD` of the day after `now`, in local time: what Z snoozes until. */
export function tomorrow(now: Date): string {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}
