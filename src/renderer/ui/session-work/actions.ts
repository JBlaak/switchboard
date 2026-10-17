/**
 * What the Session work page and its trigger do: asking main whether the page
 * can open, opening and closing it, and moving the selection.
 *
 * These only dispatch. Swapping the page in for the terminal, telling main it
 * closed, and putting the focus back follow the store (see `panel`), so every
 * way of closing it — Esc, Back, Cmd+G, another session on screen — goes
 * through one place.
 */
import { flushSync } from 'react-dom';
import { dispatch, getState } from '../../state/app-store';
import { hasEntry } from '../../state/records';
import { sessionMap } from '../../state/session-store';
import { imageKeyEvent, selectedDiff, steppedFilePath, steppedItemId } from '../../state/session-work-slice';
import type { DiffMode, ReviewKind } from '../../state/session-work-slice';
import type { DiffSide } from '../../../domain/session-work/model';
import type { ReviewMode, ReviewResult } from '../../../domain/session-work/review';
import { headerNameFor } from '../../features/sessions/terminal-header';
import { openSession } from '../../features/sessions/session-actions';
import type { WorkAction } from '../../../domain/session-work/model';
import type { ImageMode } from './image-compare/modes/types';
import type { Background, View } from './image-compare/types';

/** Sessions whose eligibility is being asked right now, so a row asks once. */
const asking = new Map<string, Promise<boolean>>();

/** Is this session remote? Then the page cannot open, and main need not be asked. */
export function isRemoteSession(sessionId: string, projectPath?: string | null): boolean {
  const session = sessionMap.get(sessionId);
  const path = projectPath ?? session?.projectPath ?? '';
  return session?.type === 'remote' || path.startsWith('ssh://');
}

/**
 * Whether the page can open for a session, asking main the first time.
 *
 * The answer is cached in the store, so a row asks once however often it
 * renders; `fresh` asks again even so (Cmd+G, on a "no" that may be stale).
 */
export function canOpenSessionWork(sessionId: string, { fresh = false } = {}): Promise<boolean> {
  if (isRemoteSession(sessionId)) return Promise.resolve(false);
  const cached = getState().sessionWork.canOpen;
  if (!fresh && hasEntry(cached, sessionId)) return Promise.resolve(cached[sessionId]);
  const pending = asking.get(sessionId);
  if (pending) return pending;

  const answer = window.api.canOpenSessionWork(sessionId)
    .catch(() => false)
    .then((canOpen) => {
      dispatch({ type: 'sessionWorkEligibility', sessionId, canOpen });
      return canOpen;
    })
    .finally(() => asking.delete(sessionId));
  asking.set(sessionId, answer);
  return answer;
}

/**
 * Open the page for a session: the skeleton at once, then the first snapshot.
 *
 * The header and the agents strip need nothing from git, so they show while
 * main reads the session's worktrees. Should main answer that the page cannot
 * open after all, it closes again.
 */
export async function openSessionWork(sessionId: string): Promise<void> {
  const session = sessionMap.get(sessionId);
  // Rendered now: the page takes its panel synchronously (see `panel`) and the
  // focus goes into it.
  flushSync(() => dispatch({
    type: 'sessionWorkOpened', sessionId, name: session ? headerNameFor(session) : '', at: Date.now(),
  }));

  let snapshot = null;
  try {
    snapshot = await window.api.openSessionWork(sessionId);
  } catch {
    snapshot = null;
  }
  if (getState().sessionWork.page?.sessionId !== sessionId) return;
  if (snapshot) dispatch({ type: 'sessionWorkSnapshot', snapshot });
  else closeSessionWork();
}

/** Close the page, whoever it is for; the terminal comes back. */
export function closeSessionWork(): void {
  const page = getState().sessionWork.page;
  if (page) dispatch({ type: 'sessionWorkClosed', sessionId: page.sessionId });
}

/** Cmd+G, wherever the focus is (D3). */
export function isSessionWorkKey(e: KeyboardEvent): boolean {
  return e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyG';
}

/** Cmd+G: the page for the session on screen, open or closed. Nothing when it cannot open. */
export async function toggleSessionWork(): Promise<void> {
  const { view, sessionWork } = getState();
  const sessionId = view.activeSessionId;
  if (!sessionId) return;
  if (sessionWork.page?.sessionId === sessionId) {
    closeSessionWork();
    return;
  }
  const cached = sessionWork.canOpen[sessionId];
  const canOpen = cached === true || await canOpenSessionWork(sessionId, { fresh: cached === false });
  // The user may have moved on while main answered.
  if (!canOpen || getState().view.activeSessionId !== sessionId) return;
  await openSessionWork(sessionId);
}

/**
 * A click on a row's meta line: put the session on screen if it is not, then
 * open its page.
 */
export async function openSessionWorkFromRow(sessionId: string): Promise<void> {
  if (getState().view.activeSessionId !== sessionId) {
    const session = sessionMap.get(sessionId);
    if (!session) return;
    await openSession(session);
    if (getState().view.activeSessionId !== sessionId) return;
  }
  await openSessionWork(sessionId);
}

export function selectWorkItem(itemId: string): void {
  dispatch({ type: 'sessionWorkItemSelected', itemId });
}

/**
 * `j` / `k`: select the next or previous item and answer its id, for the
 * caller to move the focus to; null at either end.
 */
export function stepWorkItem(direction: 1 | -1): string | null {
  const page = getState().sessionWork.page;
  if (!page) return null;
  const next = steppedItemId(page, direction);
  if (next) flushSync(() => dispatch({ type: 'sessionWorkItemSelected', itemId: next }));
  return next;
}

export function toggleDoneItems(): void {
  dispatch({ type: 'sessionWorkDoneToggled' });
}

/** Open a GitHub page in the browser (main only opens https URLs). */
export function openOnGitHub(url: string): void {
  void window.api.openExternal(url);
}

// ── Handing an item to Claude ──

/**
 * An action button: ask main to queue the action for the page's session. The
 * activity arrives with the next snapshot; a refusal shows on the item.
 */
export async function requestWorkAction(itemId: string, action: WorkAction, threadIds?: string[]): Promise<void> {
  const page = getState().sessionWork.page;
  if (!page || page.pendingAction) return;
  const { sessionId } = page;
  dispatch({ type: 'sessionWorkActionRequested', sessionId, itemId, action, ...(threadIds ? { threadIds } : {}) });
  let error: string | null;
  try {
    const result = await window.api.sessionWorkAction({ sessionId, itemId, action, ...(threadIds ? { threadIds } : {}) });
    error = result.ok ? null : result.reason;
  } catch (err) {
    error = (err as Error)?.message || 'The action could not be queued';
  }
  dispatch({ type: 'sessionWorkActionAnswered', sessionId, itemId, error });
}

/** Cancel on a queued action's card. One Claude already has cannot be taken back. */
export async function cancelWorkAction(itemId: string, activityId: string): Promise<void> {
  const page = getState().sessionWork.page;
  if (!page) return;
  let error: string | null = null;
  try {
    const result = await window.api.cancelSessionWorkAction(activityId);
    if (!result.ok) error = result.reason;
  } catch (err) {
    error = (err as Error)?.message || 'The action could not be cancelled';
  }
  if (error) dispatch({ type: 'sessionWorkActionAnswered', sessionId: page.sessionId, itemId, error });
}

/** "View in terminal": back to the session's terminal, where Claude is working on it. */
export function viewInTerminal(): void {
  closeSessionWork();
}

// ── The diff ──

/**
 * Ask main for an item's diff and file the answer. Called from the store's
 * follower (`install-session-work`) whenever `diffToLoad` names one, so the
 * selected item's diff loads lazily, once per change.
 */
export async function loadDiff(sessionId: string, itemId: string, key: string): Promise<void> {
  dispatch({ type: 'sessionWorkDiffRequested', sessionId, itemId, key });
  try {
    const diff = await window.api.getSessionWorkDiff({ sessionId, itemId });
    dispatch({ type: 'sessionWorkDiffLoaded', sessionId, itemId, key, diff });
  } catch (err) {
    dispatch({
      type: 'sessionWorkDiffFailed', sessionId, itemId, key,
      message: (err as Error)?.message || 'The diff could not be read',
    });
  }
}

export function setDiffMode(mode: DiffMode): void {
  dispatch({ type: 'sessionWorkDiffModeSet', mode });
}

/** `u`: unified ↔ split. */
export function toggleDiffMode(): void {
  const page = getState().sessionWork.page;
  if (page) setDiffMode(page.diffMode === 'unified' ? 'split' : 'unified');
}

/** "Show diff" on a collapsed file. */
export function expandFile(itemId: string, path: string): void {
  dispatch({ type: 'sessionWorkFileExpanded', itemId, path });
}

/**
 * `n` / `p`: move to the next or previous file of the selected item's diff and
 * answer its path, for the caller to bring into view; null at either end.
 */
export function stepFile(direction: 1 | -1): string | null {
  const page = getState().sessionWork.page;
  const diff = page ? selectedDiff(page) : null;
  const itemId = page?.selectedItemId;
  if (!itemId || !diff) return null;
  const path = steppedFilePath(diff, direction);
  if (path) flushSync(() => dispatch({ type: 'sessionWorkFileFocused', itemId, path }));
  return path;
}

// ── Your review (C1, C2) ──

/** `+` or `c` on a line: the composer opens under it, closing any other. */
export function openComposer(itemId: string, path: string, line: number, side: DiffSide): void {
  flushSync(() => dispatch({ type: 'sessionWorkComposerOpened', itemId, path, line, side }));
}

export function closeComposer(): void {
  dispatch({ type: 'sessionWorkComposerClosed' });
}

/**
 * Add to review: ask main to put the comment into your pending review. Answers
 * whether it went in; the snapshot that follows shows it.
 */
export async function addReviewComment(body: string): Promise<boolean> {
  const page = getState().sessionWork.page;
  const target = page?.composer;
  if (!page || !target || page.reviewPending) return false;
  const { sessionId } = page;
  const { itemId, path, line, side } = target;
  return reviewWrite(sessionId, itemId, 'comment',
    () => window.api.sessionWorkComment({ sessionId, itemId, path, line, side, body }));
}

/** A button of the pending review bar: Submit & have Claude fix, Submit only, or Discard. */
export async function finishReview(itemId: string, mode: ReviewMode): Promise<boolean> {
  const page = getState().sessionWork.page;
  if (!page || page.reviewPending) return false;
  const { sessionId } = page;
  return reviewWrite(sessionId, itemId, mode, () => window.api.sessionWorkReview({ sessionId, itemId, mode }));
}

async function reviewWrite(
  sessionId: string, itemId: string, kind: ReviewKind, write: () => Promise<ReviewResult>,
): Promise<boolean> {
  dispatch({ type: 'sessionWorkReviewRequested', sessionId, itemId, kind });
  let error: string | null;
  try {
    const result = await write();
    error = result.ok ? null : result.reason;
  } catch (err) {
    error = (err as Error)?.message || 'GitHub could not be reached';
  }
  dispatch({ type: 'sessionWorkReviewAnswered', sessionId, itemId, kind, error });
  return error === null;
}

// ── Image cards (#112) ──

/** An image card's stage measured its frame; `fit` is the view that fits it. */
export function frameImage(itemId: string, path: string, fit: View): void {
  dispatch({ type: 'sessionWorkImageFramed', itemId, path, fit });
}

export function viewImage(itemId: string, path: string, view: View): void {
  dispatch({ type: 'sessionWorkImageViewed', itemId, path, view });
}

export function setImageMode(itemId: string, path: string, mode: ImageMode): void {
  dispatch({ type: 'sessionWorkImageModeSet', itemId, path, mode });
}

export function blinkImage(itemId: string, path: string): void {
  dispatch({ type: 'sessionWorkImageBlinked', itemId, path });
}

export function setImageBackground(background: Background): void {
  dispatch({ type: 'sessionWorkImageBackgroundSet', background });
}

/**
 * `1`–`5`, `b` and `0` on the focused image card (C6). Answers whether the
 * key did anything there.
 */
export function imageKey(key: string): boolean {
  const page = getState().sessionWork.page;
  const event = page ? imageKeyEvent(page, key) : null;
  if (event) dispatch(event);
  return event !== null;
}
