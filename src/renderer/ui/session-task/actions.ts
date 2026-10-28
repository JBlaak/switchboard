/**
 * What the session's task surfaces do (#250): the header chip, the Task tab
 * on Session work, the sidebar marker, Link task… and the archive's offer.
 *
 * These call `window.api` and dispatch the answer; the rules are in
 * `state/session-task-slice`, and the offer's sequence in `offer.ts`.
 */
import { dispatch, getState } from '../../state/app-store';
import { tomorrow } from '../../state/session-task-slice';
import type { TaskAction } from '../../state/session-task-slice';
import { answerOfferWith, changeError, markDoneWith, type OfferSteps } from './offer';
import { canOpenSessionWork, openSessionWork } from '../session-work/actions';

/** How many tasks Link task… lists at a time. */
const PICKER_LIMIT = 20;

/** Tasks whose detail is being asked right now, so a surface asks once. */
const asking = new Set<string>();

/**
 * While BlaakTasks is on (`tasks.enabled`), ask main which sessions are
 * linked, then fetch the linked tasks the chip, the marker and the tab name.
 */
export async function loadSessionTasks(): Promise<void> {
  if (!getState().tasks.enabled) return;
  let links: Record<string, string>;
  try {
    links = await window.api.sessionTasks();
  } catch {
    // Kept as it was; the next switch asks again.
    return;
  }
  dispatch({ type: 'sessionTasksLoaded', links });
  for (const taskId of new Set(Object.values(links))) loadTask(taskId);
}

/** Fetch a task's detail unless it is known (or `fresh`) or already being asked. */
export function loadTask(taskId: string, { fresh = false } = {}): void {
  if (asking.has(taskId)) return;
  const known = getState().sessionTask.tasks[taskId];
  if (!fresh && known?.phase === 'loaded') return;
  asking.add(taskId);
  dispatch({ type: 'sessionTaskDetailRequested', taskId });
  void window.api.getTask(taskId)
    .catch((err: Error) => ({ kind: 'unreachable' as const, reason: err.message }))
    .then((result) => dispatch({ type: 'sessionTaskDetailLoaded', taskId, result }))
    .finally(() => asking.delete(taskId));
}

const offerSteps: OfferSteps = {
  dispatch,
  updateTask: (taskId, change) => window.api.updateTask(taskId, change),
  refresh: (taskId) => loadTask(taskId, { fresh: true }),
};

/** Mark done on the Task tab. Only ever because you pressed it. */
export function markTaskDone(taskId: string): Promise<void> {
  if (getState().sessionTask.pending) return Promise.resolve();
  return markDoneWith(offerSteps, taskId);
}

/** Snooze on the Task tab: until tomorrow, as the Tasks page's Z does. */
export async function snoozeTask(taskId: string): Promise<void> {
  if (getState().sessionTask.pending) return;
  const action: TaskAction = 'snooze';
  dispatch({ type: 'sessionTaskActionRequested', taskId, action });
  let error: string | null;
  try {
    error = changeError(await window.api.updateTask(taskId, { kind: 'snooze', until: tomorrow(new Date()) }));
  } catch (err) {
    error = (err as Error).message || 'Could not snooze it';
  }
  dispatch({ type: 'sessionTaskActionAnswered', taskId, action, error });
  if (!error) loadTask(taskId, { fresh: true });
}

/** Open in Notion. */
export function openTaskInNotion(url: string): void {
  if (url) void window.api.openExternal(url);
}

/** Open one of the task's PRs. */
export function openTaskPullRequest(url: string): void {
  void window.api.openExternal(url);
}

/** D or Leave it on the archive's offer. */
export function answerMarkDoneOffer(choice: 'done' | 'leave'): Promise<void> {
  const { offer } = getState().sessionTask;
  if (!offer) return Promise.resolve();
  return answerOfferWith(offerSteps, offer, choice);
}

/**
 * The header chip: the session's Session work page, on its Task tab. The tab
 * is set first, so the page opens on it; nothing opens where the page cannot.
 */
export async function openTaskTab(sessionId: string): Promise<void> {
  dispatch({ type: 'sessionWorkTabSet', sessionId, tab: 'task' });
  if (getState().sessionWork.page?.sessionId === sessionId) return;
  if (await canOpenSessionWork(sessionId, { fresh: getState().sessionWork.canOpen[sessionId] === false })) {
    await openSessionWork(sessionId);
  }
}

// ── Link task… ──

/** Link task… on Session work: the picker opens, listing ★ Today until something is typed. */
export function openTaskPicker(sessionId: string): void {
  dispatch({ type: 'sessionTaskPickerOpened', sessionId });
  void searchTasks('');
}

export function closeTaskPicker(): void {
  dispatch({ type: 'sessionTaskPickerClosed' });
}

/** The picker's search: open tasks matching `query`, or ★ Today while it is empty. */
export async function searchTasks(query: string): Promise<void> {
  dispatch({ type: 'sessionTaskSearchChanged', query });
  const trimmed = query.trim();
  const result = await window.api.listTasks(trimmed
    ? { view: 'today', options: { query: trimmed, limit: PICKER_LIMIT } }
    : { view: 'today', options: { limit: PICKER_LIMIT } })
    .catch((err: Error) => ({ kind: 'unreachable' as const, reason: err.message }));
  dispatch({ type: 'sessionTaskSearchAnswered', query, result });
}

export function stepTaskPicker(step: 1 | -1): void {
  dispatch({ type: 'sessionTaskPickerStepped', step });
}

/** A task picked: the session works on it now, replacing any it had. */
export async function linkTask(sessionId: string, taskId: string): Promise<void> {
  closeTaskPicker();
  const answer = await window.api.linkSessionTask(sessionId, taskId).catch((err: Error) => ({ ok: false, error: err.message }));
  // Main pushes the link too; this makes the surfaces follow at once either way.
  if (answer?.ok !== false) {
    dispatch({ type: 'sessionTaskChanged', sessionId, taskId });
    loadTask(taskId);
  }
}

/** Unlink: the session no longer works on a task. */
export async function unlinkTask(sessionId: string): Promise<void> {
  closeTaskPicker();
  const answer = await window.api.unlinkSessionTask(sessionId).catch((err: Error) => ({ ok: false, error: err.message }));
  if (answer?.ok !== false) {
    dispatch({ type: 'sessionTaskChanged', sessionId, taskId: null });
    if (getState().sessionWork.tabs[sessionId] === 'task') dispatch({ type: 'sessionWorkTabSet', sessionId, tab: 'work' });
  }
}
