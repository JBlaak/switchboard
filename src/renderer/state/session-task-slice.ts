/**
 * The task a session works on (#250): which sessions are linked to which
 * BlaakTasks task, what is known of those tasks, the Link task… picker, and
 * the Mark done offer an archive can bring.
 *
 * Main owns the links (#245, #248); this keeps the renderer's copy, filled
 * from `sessionTasks()` whenever BlaakTasks is switched on (at launch, or a
 * Settings save; `blaakTasksSwitched`, whose flag is `tasks.enabled` in
 * `tasks-slice`), and kept up by the `sessionTaskChanged` pushes. Switched
 * off, the links, the picker and the offer are dropped, so nothing here
 * shows; Link task… reads the same flag.
 *
 * The tasks themselves are fetched one by one (`getTask`) for the chip, the
 * Task tab and the offer, and kept while the app runs; a change from here
 * (Mark done, Snooze) asks again.
 *
 * The events are declared here rather than in `events.ts`, like the project
 * page's, so the vocabulary stays in one file.
 */
import { movedEntry, withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';
import type { BlaakTasksResult, TaskDetail, TaskRow, TaskStatus } from '../../domain/tasks/model';
import type { PullRequestStatus } from '../../domain/session-work/model';
import { statusDotLabel, type StatusDot } from '../../domain/session-work/status';
import { SESSION_ARCHIVED_LINE } from '../../domain/tasks/writes';

export type SessionTaskEvent =
  /** What main says now: every linked session's task. */
  | { type: 'sessionTasksLoaded'; links: Record<string, string> }
  /** A task's detail was asked of main. */
  | { type: 'sessionTaskDetailRequested'; taskId: string }
  /** Main answered a task's detail. */
  | { type: 'sessionTaskDetailLoaded'; taskId: string; result: BlaakTasksResult<TaskDetail> }
  /** Mark done or Snooze was pressed on a task. */
  | { type: 'sessionTaskActionRequested'; taskId: string; action: TaskAction }
  /** Main answered it: `error` null when it went through (or was queued). */
  | { type: 'sessionTaskActionAnswered'; taskId: string; action: TaskAction; error: string | null }
  /** Link task… opened for a session. */
  | { type: 'sessionTaskPickerOpened'; sessionId: string }
  /** The picker closed: Esc, a pick, an unlink. */
  | { type: 'sessionTaskPickerClosed' }
  /** The picker's search text changed; its answer is asked of main. */
  | { type: 'sessionTaskSearchChanged'; query: string }
  /** Main answered a search; an answer for an older query is dropped. */
  | { type: 'sessionTaskSearchAnswered'; query: string; result: BlaakTasksResult<TaskRow[]> }
  /** ↑/↓ in the picker's results. */
  | { type: 'sessionTaskPickerStepped'; step: 1 | -1 }
  /** The archive's offer was answered (D, or Leave it), or put away. */
  | { type: 'sessionTaskOfferClosed' };

/** What can be done to a task from a session. */
export type TaskAction = 'done' | 'snooze';

/** What is known of one task. */
export type TaskLoad =
  | { readonly phase: 'loading'; readonly detail: TaskDetail | null }
  | { readonly phase: 'loaded'; readonly detail: TaskDetail }
  /** `detail` is the last one that came, kept so the surfaces stay put. */
  | { readonly phase: 'failed'; readonly detail: TaskDetail | null; readonly reason: string };

/** Link task…: searching the tasks for one to link a session to. */
export interface TaskPicker {
  readonly sessionId: string;
  readonly query: string;
  readonly phase: 'searching' | 'done' | 'failed';
  readonly results: readonly TaskRow[];
  /** The result the keyboard is on. */
  readonly cursor: number;
  readonly error: string | null;
}

export interface SessionTaskState {
  /** sessionId → the id of the task it works on. */
  readonly links: IdRecord<string>;
  /** taskId → what is known of it. */
  readonly tasks: IdRecord<TaskLoad>;
  /** The change asked of main and not answered yet: its button does not take a second press. */
  readonly pending: { readonly taskId: string; readonly action: TaskAction } | null;
  /** Why the last change did not go through, shown on its task until the next one. */
  readonly actionError: { readonly taskId: string; readonly message: string } | null;
  readonly picker: TaskPicker | null;
  /** Mark “<title>” done?, after you archived a session whose PRs are all merged. */
  readonly offer: { readonly sessionId: string; readonly taskId: string } | null;
}

export const initialSessionTaskState: SessionTaskState = {
  links: {}, tasks: {}, pending: null, actionError: null, picker: null, offer: null,
};

/** `blaakTasksOn` is `tasks.enabled` as this event left it: Link task… opens only while it is on. */
export function sessionTaskReducer(state: SessionTaskState, event: RendererEvent, blaakTasksOn = true): SessionTaskState {
  switch (event.type) {
    case 'sessionTasksLoaded':
      return { ...state, links: { ...event.links } };
    // Off: no session has a task, and nothing asks about one.
    case 'blaakTasksSwitched':
      return event.on ? state : { ...state, links: {}, picker: null, offer: null };
    case 'sessionTaskChanged': {
      const links = event.taskId
        ? withEntry(state.links, event.sessionId, event.taskId)
        : withoutEntry(state.links, event.sessionId);
      return links === state.links ? state : { ...state, links };
    }
    case 'sessionTaskDetailRequested': {
      const known = state.tasks[event.taskId];
      if (known?.phase === 'loading') return state;
      return { ...state, tasks: withEntry(state.tasks, event.taskId, { phase: 'loading', detail: known?.detail ?? null }) };
    }
    case 'sessionTaskDetailLoaded': {
      const known = state.tasks[event.taskId];
      const load: TaskLoad = event.result.kind === 'ok'
        ? { phase: 'loaded', detail: event.result.value }
        : { phase: 'failed', detail: known?.detail ?? null, reason: failureReason(event.result) };
      return { ...state, tasks: withEntry(state.tasks, event.taskId, load) };
    }
    case 'sessionTaskActionRequested':
      if (state.pending) return state;
      return { ...state, pending: { taskId: event.taskId, action: event.action }, actionError: null };
    case 'sessionTaskActionAnswered': {
      if (state.pending?.taskId !== event.taskId || state.pending.action !== event.action) return state;
      if (event.error) return { ...state, pending: null, actionError: { taskId: event.taskId, message: event.error } };
      // Done shows at once; the detail asked again afterwards confirms it.
      const known = state.tasks[event.taskId];
      const tasks = event.action === 'done' && known?.detail
        ? withEntry(state.tasks, event.taskId, { ...known, detail: { ...known.detail, status: 'Done' } } as TaskLoad)
        : state.tasks;
      return { ...state, pending: null, actionError: null, tasks };
    }
    case 'sessionTaskPickerOpened':
      if (!blaakTasksOn) return state;
      return {
        ...state,
        picker: { sessionId: event.sessionId, query: '', phase: 'searching', results: [], cursor: 0, error: null },
      };
    case 'sessionTaskPickerClosed':
      return state.picker ? { ...state, picker: null } : state;
    case 'sessionTaskSearchChanged':
      if (!state.picker) return state;
      return { ...state, picker: { ...state.picker, query: event.query, phase: 'searching', error: null } };
    case 'sessionTaskSearchAnswered': {
      const { picker } = state;
      if (!picker || picker.query !== event.query) return state;
      if (event.result.kind !== 'ok') {
        return { ...state, picker: { ...picker, phase: 'failed', error: failureReason(event.result) } };
      }
      return { ...state, picker: { ...picker, phase: 'done', results: event.result.value, cursor: 0, error: null } };
    }
    case 'sessionTaskPickerStepped': {
      const { picker } = state;
      if (!picker || picker.results.length === 0) return state;
      const cursor = Math.min(picker.results.length - 1, Math.max(0, picker.cursor + event.step));
      return cursor === picker.cursor ? state : { ...state, picker: { ...picker, cursor } };
    }
    case 'taskMarkDoneOffered':
      return { ...state, offer: { sessionId: event.sessionId, taskId: event.taskId } };
    case 'sessionTaskOfferClosed':
      return state.offer ? { ...state, offer: null } : state;
    case 'tasksChanged':
      return withRows(state, event.update.rows);
    default:
      return state;
  }
}

/** A task list came in (the Tasks page's poll): the tasks known here take its rows' fresh fields. */
function withRows(state: SessionTaskState, rows: readonly TaskRow[]): SessionTaskState {
  let tasks = state.tasks;
  for (const row of rows) {
    const known = tasks[row.id];
    if (!known?.detail) continue;
    const { detail } = known;
    if (detail.title === row.title && detail.status === row.status && detail.today === row.today
      && detail.snoozedUntil === row.snoozedUntil && sameList(detail.pullRequests, row.pullRequests)) continue;
    tasks = withEntry(tasks, row.id, { ...known, detail: { ...detail, ...row } } as TaskLoad);
  }
  return tasks === state.tasks ? state : { ...state, tasks };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function failureReason(result: Exclude<BlaakTasksResult<unknown>, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'off': return 'BlaakTasks is off';
    case 'notSetUp': return 'BlaakTasks is not set up in Claude Code';
    case 'unreachable': return 'Couldn’t reach BlaakTasks';
    case 'failed': return result.reason;
  }
}

/** A re-keyed session keeps its task, its open picker and its offer; see `rekeyState` in `root`. */
export function rekeySessionTask(state: SessionTaskState, oldId: string, newId: string): SessionTaskState {
  const links = movedEntry(state.links, oldId, newId);
  const picker = state.picker?.sessionId === oldId ? { ...state.picker, sessionId: newId } : state.picker;
  const offer = state.offer?.sessionId === oldId ? { ...state.offer, sessionId: newId } : state.offer;
  return links === state.links && picker === state.picker && offer === state.offer
    ? state
    : { ...state, links, picker, offer };
}

// ── Reading it ──

/** The id of the task a session works on, or null (always null while BlaakTasks is off: it has no links then). */
export function taskIdOf(state: SessionTaskState, sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return state.links[sessionId] ?? null;
}

/** What is known of a session's task: its id and, once fetched, its detail. Null when it has none. */
export function sessionTaskOf(
  state: SessionTaskState, sessionId: string | null | undefined,
): { taskId: string; load: TaskLoad | null; detail: TaskDetail | null } | null {
  const taskId = taskIdOf(state, sessionId);
  if (!taskId) return null;
  const load = state.tasks[taskId] ?? null;
  return { taskId, load, detail: load?.detail ?? null };
}

/** The line a task goes by: its summary when it has one, else its title. */
export function taskName(detail: Pick<TaskRow, 'title' | 'summary'>): string {
  return detail.summary?.trim() || detail.title;
}

/** A task status's pill tone. */
export type StatusTone = 'blue' | 'grey' | 'amber' | 'green';

export function statusTone(status: TaskStatus): StatusTone {
  switch (status) {
    case 'In progress': return 'blue';
    case 'Waiting': return 'amber';
    case 'Done': return 'green';
    default: return 'grey';
  }
}

/** The offer's question. The title is quoted in full; the toast ellipsises it. */
export function offerQuestion(detail: Pick<TaskRow, 'title' | 'summary'> | null): string {
  return detail ? `Mark “${taskName(detail)}” done?` : 'Mark its task done?';
}

/** The day after `now`, local, as `YYYY-MM-DD`: what Snooze snoozes a task until. */
export function tomorrow(now: Date): string {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

/** One of the task's PRs as the Task tab shows it. */
export interface TaskPullRequestPill {
  readonly url: string;
  readonly label: string;
  readonly tone: 'blue' | 'lavender' | 'grey' | 'green' | 'amber' | 'red';
  /** The PR's state in words, for its tooltip; null when nothing is known of it. */
  readonly state: string | null;
}

const PR_URL = /\/([^/]+\/[^/]+)\/pull\/(\d+)/;

/**
 * The task's PRs, each with what the session already knows of it: its state
 * from the Session work page's own PR items, else the CI watch's dot for the
 * session's PRs, else just its number.
 */
export function taskPullRequestPills(
  urls: readonly string[],
  known: readonly Pick<PullRequestStatus, 'url' | 'number' | 'repository' | 'state'>[],
  dots: (number: number) => StatusDot | null,
): TaskPullRequestPill[] {
  return urls.map((url) => {
    const match = PR_URL.exec(url);
    const number = match ? Number(match[2]) : null;
    const label = number !== null ? '#' + number : url.replace(/^https?:\/\//, '');
    const pr = known.find((item) => item.url === url
      || (number !== null && item.number === number && item.repository.toLowerCase() === match![1].toLowerCase()));
    if (pr?.state) {
      const tone = pr.state === 'merged' ? 'lavender' : pr.state === 'closed' ? 'grey' : pr.state === 'draft' ? 'grey' : 'blue';
      return { url, label: label + ' ' + pr.state, tone, state: pr.state };
    }
    const dot = number !== null ? dots(number) : null;
    if (dot === 'merged') return { url, label: label + ' merged', tone: 'lavender', state: 'merged' };
    if (dot) return { url, label, tone: dot, state: statusDotLabel(dot) };
    return { url, label, tone: 'grey', state: null };
  });
}

/**
 * Whether a progress line is one Switchboard wrote (#247): an opened PR, the
 * archive, or the start BlaakTasks logs when a session set it In progress.
 * The Task tab draws those in the accent; the rest come from Claude.
 */
export function writtenBySwitchboard(text: string): boolean {
  const line = text.trim();
  return line === SESSION_ARCHIVED_LINE || line === 'Claude started work' || /^Opened PR #\d+$/.test(line);
}
