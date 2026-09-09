/**
 * What a session is asking to change, and how far the review has got.
 *
 * The CLI parks a call per edit it proposes: it opens a diff over the IDE
 * bridge and waits for `resolveDiff` to answer it. That makes this the one
 * surface in the app whose state can answer a process on the user's behalf, so
 * the part with decisions in it is kept here, with no DOM and no `window.api` —
 * `review-view.ts` builds editors and sends the answers and decides nothing
 * else worth asserting on. Same split as `main-mode-model.ts` and
 * `changes-list-model.ts`, for the same reason: this is the file a test can
 * import.
 *
 * Two rules run through everything below.
 *
 * **Nothing here answers anything.** Every function returns state or a fact.
 * `isPending` is the guard the view asks before it sends, and a resolved item
 * never becomes pending again, which is what makes a double click on Accept
 * one answer rather than two.
 *
 * **An arrival never moves the reader.** A session may propose a second edit
 * while the first is still on screen. Both stay in the list, and the one being
 * read keeps the surface — jumping to the newcomer would put a different file
 * under a hand already travelling towards Accept.
 */

/** One edit a session is asking to make, as the bridge described it. */
export interface ProposedEdit {
  /** The bridge's id for this parked call. The only thing `resolveDiff` needs. */
  diffId: string;
  /** The file on disk. Read by the bridge, so the diff is against reality. */
  filePath: string;
  /** The CLI's own label for the tab it thinks it opened. */
  tabName: string;
  oldContent: string;
  newContent: string;
}

/**
 * How an edit was answered.
 *
 * The three the bridge understands, spelled the way `mcpDiffResponse` wants
 * them: `accept-edited` is an accept of a buffer the user changed in the merge
 * view, and carries the content instead of the CLI's own.
 */
export type ReviewOutcome = 'accept' | 'accept-edited' | 'reject';

/** One proposed edit and what became of it. */
export interface ReviewItem {
  edit: ProposedEdit;
  /** null while the CLI is still parked on this one. */
  outcome: ReviewOutcome | null;
}

/**
 * Everything one session has asked for, in the order it asked.
 *
 * Per session, because two sessions can each be waiting on an answer and the
 * review of one must never show under the other's name. The id is a field
 * rather than only a map key so a fork can move the whole review across in one
 * step — see `rekeyReview`.
 */
export interface ReviewState {
  sessionId: string;
  items: readonly ReviewItem[];
  /** The edit on screen, or null when there is nothing left to show. */
  currentDiffId: string | null;
}

export function emptyReview(sessionId: string): ReviewState {
  return { sessionId, items: [], currentDiffId: null };
}

/**
 * Take in an edit the session has just proposed.
 *
 * A `diffId` already known is replaced in place rather than appended: the
 * bridge mints one per call, so the same id twice is the same request arriving
 * again, and a second row for it would offer the user two buttons that answer
 * one parked call.
 *
 * The newcomer only takes the surface when nothing unanswered is on it. That is
 * the "an arrival never moves the reader" rule: with a file half read, the new
 * edit joins the list and waits its turn; with the last one already answered,
 * there is nothing to interrupt and the review moves on by itself.
 */
export function addProposal(state: ReviewState, edit: ProposedEdit): ReviewState {
  const known = state.items.findIndex(item => item.edit.diffId === edit.diffId);
  const items = known === -1
    ? [...state.items, { edit, outcome: null }]
    : state.items.map((item, i) => (i === known ? { edit, outcome: item.outcome } : item));

  const current = currentItem(state);
  const holding = current !== null && current.outcome === null && current.edit.diffId !== edit.diffId;

  return { ...state, items, currentDiffId: holding ? state.currentDiffId : edit.diffId };
}

/** Put one of the proposed edits on screen. Unknown ids leave the state alone. */
export function selectProposal(state: ReviewState, diffId: string): ReviewState {
  if (!state.items.some(item => item.edit.diffId === diffId)) return state;
  return { ...state, currentDiffId: diffId };
}

/**
 * Record how an edit was answered, and move to the next one still parked.
 *
 * Answering the last one does *not* clear the surface: the file stays up,
 * marked, so the user can see what they just did. Only the CLI withdrawing an
 * edit takes it off the list — see `withdrawProposal`.
 *
 * An item that is already answered, or one that was never here, is returned
 * unchanged. The view checks `isPending` before it sends, so this is the second
 * half of the same guard rather than the only one.
 */
export function resolveProposal(
  state: ReviewState, diffId: string, outcome: ReviewOutcome,
): ReviewState {
  if (!isPending(state, diffId)) return state;

  const items = state.items.map(item => (
    item.edit.diffId === diffId ? { edit: item.edit, outcome } : item
  ));
  const next = { ...state, items };
  const following = nextPendingAfter(next, diffId);

  return following === null ? next : { ...next, currentDiffId: following };
}

/**
 * Drop an edit the CLI has withdrawn.
 *
 * `close_tab` and `closeAllDiffTabs` are answered by the bridge itself, in
 * main, before the renderer hears about them: by the time this runs the call is
 * no longer parked, so removing the row here sends nothing and owes nothing.
 */
export function withdrawProposal(state: ReviewState, diffId: string): ReviewState {
  const items = state.items.filter(item => item.edit.diffId !== diffId);
  if (items.length === state.items.length) return state;

  if (state.currentDiffId !== diffId) return { ...state, items };

  const shrunk = { ...state, items, currentDiffId: null };
  return { ...shrunk, currentDiffId: firstPending(shrunk) ?? items[items.length - 1]?.edit.diffId ?? null };
}

/** Drop the lot: the CLI closed every diff it had open for this session. */
export function withdrawAll(state: ReviewState): ReviewState {
  return emptyReview(state.sessionId);
}

/**
 * Move a whole review onto a session's new id.
 *
 * A fork or an accepted plan re-keys a running session, and main re-keys the
 * bridge with it. An answer sent under the old id would find no parked call and
 * the CLI would wait for one that can no longer arrive.
 */
export function rekeyReview(state: ReviewState, sessionId: string): ReviewState {
  return { ...state, sessionId };
}

/** The edit on screen, or null. */
export function currentItem(state: ReviewState): ReviewItem | null {
  if (state.currentDiffId === null) return null;
  return state.items.find(item => item.edit.diffId === state.currentDiffId) ?? null;
}

/** True while the CLI is still parked on this edit — the guard before sending. */
export function isPending(state: ReviewState, diffId: string): boolean {
  const item = state.items.find(entry => entry.edit.diffId === diffId);
  return item !== undefined && item.outcome === null;
}

/**
 * Everything an "accept all" would answer.
 *
 * Only what is still parked. An edit the user already rejected keeps that
 * answer: the CLI has been told, the call is gone, and "all" cannot reach back
 * and change a decision the user made one click ago.
 */
export function pendingProposals(state: ReviewState): readonly ReviewItem[] {
  return state.items.filter(item => item.outcome === null);
}

/** How the header counts: `reviewed` of `total`. */
export function reviewProgress(state: ReviewState): { reviewed: number; total: number } {
  return {
    reviewed: state.items.filter(item => item.outcome !== null).length,
    total: state.items.length,
  };
}

/** Every edit answered, and there was at least one. */
export function isReviewComplete(state: ReviewState): boolean {
  return state.items.length > 0 && pendingProposals(state).length === 0;
}

/** Nothing proposed, or everything withdrawn: the surface has nothing to show. */
export function isReviewEmpty(state: ReviewState): boolean {
  return state.items.length === 0;
}

/** `2 of 5 reviewed`, or `1 file` before anything has been answered. */
export function progressLabel(state: ReviewState): string {
  const { reviewed, total } = reviewProgress(state);
  if (total === 0) return 'nothing to review';
  if (reviewed === 0) return `${total} file${total === 1 ? '' : 's'} to review`;
  return `${reviewed} of ${total} reviewed`;
}

// ── walking the list ──────────────────────────────────────────────────────────

/**
 * The next parked edit after this one, wrapping to the start.
 *
 * Wraps because the list is not read in order: the user can click any file in
 * it, and answering the third of five should land on the fourth, but answering
 * the fifth should come back for the first if that one is still waiting.
 */
function nextPendingAfter(state: ReviewState, diffId: string): string | null {
  const from = state.items.findIndex(item => item.edit.diffId === diffId);
  if (from === -1) return firstPending(state);

  for (let step = 1; step <= state.items.length; step++) {
    const item = state.items[(from + step) % state.items.length];
    if (item.outcome === null) return item.edit.diffId;
  }
  return null;
}

function firstPending(state: ReviewState): string | null {
  return state.items.find(item => item.outcome === null)?.edit.diffId ?? null;
}
