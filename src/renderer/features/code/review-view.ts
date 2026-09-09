/**
 * Reviewing the edits a session proposes.
 *
 * The CLI asks an editor to show a diff and then *waits*: the call is parked in
 * the IDE bridge until `mcpDiffResponse` answers it. This surface is what
 * answers it, and it used to live in the per-session file panel — one diff at a
 * time, in a 450px column beside the terminal. It is here now because the code
 * area is where code is read, and because a session proposing five edits is a
 * list to work through rather than five separate interruptions.
 *
 * Three things are load-bearing.
 *
 * **Only a person answers.** Every send is behind `isPending` and a click. No
 * layout change, no fold, no session switch and no re-render reaches
 * `mcpDiffResponse` — the split's own history is why: `closeFilePanel` exists
 * precisely because the panel's close button rejected, and a fold must not.
 *
 * **Nothing is unmounted to hide it.** The merge view for each file is built
 * once and kept, so moving between the files of one review, or flipping to the
 * conversation and back, does not throw away edits the user typed into the
 * right-hand side.
 *
 * **The editor is only built while it can be measured.** CodeMirror measures its
 * host as it is created, and a merge view created inside a `display: none`
 * container comes up with no gutter and a zero-width second pane. So a paint
 * that lands while this half is folded draws the header and the file list and
 * marks itself dirty; `refreshReview()` finishes the job when the half is back.
 *
 * State is per session, keyed by session id: two sessions can each be waiting,
 * and one's edit must never appear under the other's name. The rules — which
 * file is current, what is still parked, what "accept all" reaches — are in
 * `review-model.ts`, which has no DOM in it and is tested directly.
 */
import { cleanDisplayName } from '../../../domain/session/title';
import { codeArea } from '../../lib/dom';
import { createMergeViewer, createUnifiedMergeViewer } from '../../lib/codemirror-setup';
import { openSessions, sessionMap } from '../../state/session-store';
import {
  addProposal, currentItem, emptyReview, isPending, isReviewEmpty, pendingProposals,
  progressLabel, rekeyReview, resolveProposal, selectProposal, withdrawAll, withdrawProposal,
} from './review-model';
import type { ProposedEdit, ReviewItem, ReviewOutcome, ReviewState } from './review-model';

export type { ProposedEdit } from './review-model';

/**
 * Where the review draws: a strip in the code area's header, and the surface
 * below it. Two mounts rather than one because the header bar is shared with
 * the file breadcrumb and `code-area.ts` owns which of them is up.
 */
export interface ReviewMounts {
  header: HTMLElement;
  body: HTMLElement;
}

/**
 * Side-by-side or inline, under the key the file panel already used.
 *
 * The key name is deliberately not modernised: it holds a preference real users
 * have already set, and renaming it would quietly put everyone back on the
 * default the first time they opened a review.
 */
const LAYOUT_KEY = 'filePanelDiffMode';
type ReviewLayout = 'inline' | 'side-by-side';

/**
 * A merge view, however it was built.
 *
 * `createMergeViewer` returns a `MergeView`, whose editable half is `.b`;
 * `createUnifiedMergeViewer` returns a plain `EditorView`, whose document *is*
 * the edited half. Structural rather than a union so the one place that reads
 * the edited text can ask for whichever it has.
 */
interface ReviewEditor {
  dom: HTMLElement;
  destroy(): void;
  state?: { doc: { toString(): string } };
  b?: { state: { doc: { toString(): string } } };
}

interface MountedEditor {
  /**
   * The box the editor was built into, one per file.
   *
   * Not `#code-review-body` directly: CodeMirror's floating search and
   * goto-line bars are cached on the editor's parent element (`_cmSearchBar`),
   * so two files sharing one parent would reuse the first file's search bar
   * over the second file's document.
   */
  host: HTMLElement;
  editor: ReviewEditor;
  layout: ReviewLayout;
}

/** sessionId → what that session has asked for. */
const reviews = new Map<string, ReviewState>();

/** diffId → the merge view built for it, kept across every hide. */
const editors = new Map<string, MountedEditor>();

type ReviewListener = (sessionId: string) => void;
const listeners = new Set<ReviewListener>();

let mounts: ReviewMounts | null = null;
let layout: ReviewLayout = localStorage.getItem(LAYOUT_KEY) === 'inline' ? 'inline' : 'side-by-side';

/** Whose review the surface is currently drawing. */
let shownSessionId: string | null = null;

/** Set by a paint that could not build an editor because the half was folded. */
let dirty = false;

// Header parts, filled once at install so a redraw replaces text and not nodes.
let sessionEl: HTMLElement;
let fileEl: HTMLElement;
let progressEl: HTMLElement;
let layoutBtn: HTMLButtonElement;
let rejectBtn: HTMLButtonElement;
let acceptBtn: HTMLButtonElement;
let acceptAllBtn: HTMLButtonElement;

// Body parts.
let filesEl: HTMLElement;
let bodyEl: HTMLElement;

// ── install ───────────────────────────────────────────────────────────────────

export function installReviewView(where: ReviewMounts): void {
  if (mounts) return;
  mounts = where;

  const asking = document.createElement('span');
  asking.className = 'code-review-asking';
  sessionEl = span('code-review-session');
  asking.append(sessionEl, span('code-review-verb', 'proposes'));
  fileEl = span('code-review-file');
  progressEl = span('code-review-progress');
  where.header.append(asking, fileEl, progressEl);

  const controls = document.createElement('div');
  controls.className = 'code-review-controls';

  layoutBtn = button('code-review-layout', '', () => toggleLayout());
  paintLayoutButton();

  // Reject before Accept, and Accept last: the destructive answer must never be
  // the one under a hand travelling to the corner of the window.
  rejectBtn = button('code-review-reject', 'Reject', () => answerCurrent('reject'));
  acceptBtn = button('code-review-accept', 'Accept', () => answerCurrent('accept'));
  acceptAllBtn = button('code-review-accept-all', 'Accept all', () => acceptAll());

  controls.append(layoutBtn, rejectBtn, acceptBtn, acceptAllBtn);
  where.header.appendChild(controls);

  filesEl = document.createElement('div');
  filesEl.id = 'code-review-files';
  // Delegated: the rows are rebuilt on every answer, and a listener per row
  // would be re-attached for every file of every review.
  filesEl.addEventListener('click', event => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('.code-review-row');
    const diffId = row?.dataset.diffId;
    if (diffId === undefined || shownSessionId === null) return;
    update(shownSessionId, state => selectProposal(state, diffId));
  });

  bodyEl = document.createElement('div');
  bodyEl.id = 'code-review-body';

  where.body.append(filesEl, bodyEl);
}

// ── what the bridge sends ─────────────────────────────────────────────────────

/**
 * A session is asking to change a file.
 *
 * Recorded whoever it is for. Bringing the window round to it is the caller's
 * decision, not this module's — see `app/ipc-listeners.ts`, which only steals
 * the window for the session the user is already in.
 */
export function proposeEdit(sessionId: string, edit: ProposedEdit): void {
  update(sessionId, state => addProposal(state, edit));
}

/**
 * The CLI withdrew one diff.
 *
 * Already answered by the bridge, in main, before this arrives — `close_tab`
 * resolves the parked call as accepted on its way past. So this drops a row and
 * sends nothing.
 */
export function withdrawEdit(sessionId: string, diffId: string): void {
  if (!reviews.has(sessionId)) return;
  disposeEditor(diffId);
  update(sessionId, state => withdrawProposal(state, diffId));
}

/** The CLI closed every diff it had open. Same story, all of them. */
export function withdrawEdits(sessionId: string): void {
  const state = reviews.get(sessionId);
  if (!state) return;
  for (const item of state.items) disposeEditor(item.edit.diffId);
  update(sessionId, withdrawAll);
}

/**
 * A fork re-keyed the session under us.
 *
 * Main re-keys the bridge at the same moment, so an answer still addressed to
 * the old id would find no parked call and the CLI would wait forever.
 */
export function rekeyReviewSession(oldId: string, newId: string): void {
  const state = reviews.get(oldId);
  if (!state) return;
  reviews.delete(oldId);
  reviews.set(newId, rekeyReview(state, newId));
  if (shownSessionId === oldId) shownSessionId = newId;
  notify(newId);
}

// ── what the code area asks ───────────────────────────────────────────────────

/** What one session has asked for, or null if it has asked for nothing. */
export function reviewFor(sessionId: string | null): ReviewState | null {
  return sessionId === null ? null : reviews.get(sessionId) ?? null;
}

/** True while a session has anything on the review surface, answered or not. */
export function hasReview(sessionId: string | null): boolean {
  const state = reviewFor(sessionId);
  return state !== null && !isReviewEmpty(state);
}

/** True while a session is still holding the CLI on at least one edit. */
export function hasPendingReview(sessionId: string | null): boolean {
  const state = reviewFor(sessionId);
  return state !== null && pendingProposals(state).length > 0;
}

/** Draw one session's review. Idempotent, and safe while the half is folded. */
export function showReviewFor(sessionId: string): void {
  shownSessionId = sessionId;
  paint();
}

/**
 * Finish a paint that was deferred because this half was folded.
 *
 * Called by the code area after anything that can make the surface visible. A
 * no-op unless a paint actually gave up, so it costs a boolean on the flip.
 */
export function refreshReview(): void {
  if (dirty) paint();
}

/** Be told when a review changes, so the surface around it can redraw. */
export function onReviewChange(fn: ReviewListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── answering ─────────────────────────────────────────────────────────────────

/**
 * Answer the edit on screen.
 *
 * The accept path is the file panel's, unchanged: an accepted buffer the user
 * typed into is sent as `accept-edited` with its content, and one they left
 * alone is a plain `accept`. The comparison is against the content the CLI
 * proposed, so re-typing the same text is still a plain accept.
 */
function answerCurrent(outcome: 'accept' | 'reject'): void {
  const sessionId = shownSessionId;
  const state = reviewFor(sessionId);
  if (sessionId === null || state === null) return;

  const item = currentItem(state);
  if (item === null) return;
  answer(sessionId, item, outcome);
}

/**
 * Answer everything still parked, as accepted.
 *
 * "All" means all of what is *waiting*. An edit the user already rejected keeps
 * that answer: its call is gone, and reaching back through it would turn one
 * button into a way to undo a decision the CLI has already been told about.
 */
function acceptAll(): void {
  const sessionId = shownSessionId;
  const state = reviewFor(sessionId);
  if (sessionId === null || state === null) return;

  for (const item of pendingProposals(state)) answer(sessionId, item, 'accept');
}

/** The one place that answers the CLI. */
function answer(sessionId: string, item: ReviewItem, outcome: 'accept' | 'reject'): void {
  const state = reviews.get(sessionId);
  const { diffId } = item.edit;
  // The guard against a second answer to one parked call: a double click, or an
  // "accept all" racing the button for the file already on screen.
  if (!state || !isPending(state, diffId)) return;

  let sent: ReviewOutcome = outcome;
  let content: string | null = null;

  if (outcome === 'accept') {
    const edited = editedContent(diffId);
    if (edited && edited !== item.edit.newContent) {
      sent = 'accept-edited';
      content = edited;
    }
  }

  // Recorded first, because the record is what stops the next click answering
  // the same parked call — and because main drops an answer to a call it no
  // longer holds, so the worst this order can do is under-send, never double.
  update(sessionId, current => resolveProposal(current, diffId, sent));
  window.api.mcpDiffResponse(sessionId, diffId, sent, content);
}

/** The right-hand side of a merge view, or null if it was never built. */
function editedContent(diffId: string): string | null {
  const mounted = editors.get(diffId);
  if (!mounted) return null;
  const { editor, layout: builtWith } = mounted;
  if (builtWith === 'inline') return editor.state?.doc.toString() ?? null;
  return editor.b?.state.doc.toString() ?? null;
}

// ── layout ────────────────────────────────────────────────────────────────────

/**
 * Swap inline and side-by-side, for every file of the review.
 *
 * Every built editor goes, because the preference is not per file: keeping the
 * old ones would mean the second file of a review opened in the layout the user
 * has just turned off. Edits typed into a merge view are lost with it, which is
 * the same trade the file panel's toggle made.
 */
function toggleLayout(): void {
  layout = layout === 'inline' ? 'side-by-side' : 'inline';
  localStorage.setItem(LAYOUT_KEY, layout);
  paintLayoutButton();

  for (const diffId of [...editors.keys()]) disposeEditor(diffId);
  paint();
}

function paintLayoutButton(): void {
  layoutBtn.textContent = layout === 'inline' ? 'Side-by-Side' : 'Inline';
  layoutBtn.title = layout === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';
}

// ── state plumbing ────────────────────────────────────────────────────────────

/** Apply a rule from the model, redraw if it is the review on screen, tell the rest. */
function update(sessionId: string, change: (state: ReviewState) => ReviewState): void {
  const before = reviews.get(sessionId) ?? emptyReview(sessionId);
  const after = change(before);
  if (after === before) return;

  reviews.set(sessionId, after);
  if (shownSessionId === sessionId) {
    try {
      paint();
    } catch (err) {
      // `answer` records the outcome through here and sends immediately after.
      // A merge view that fails to draw must not be what stops the CLI from
      // being told — it is parked until it hears back, and a redraw is the
      // cheapest thing in this file to lose.
      console.error('review failed to draw', err);
    }
  }
  notify(sessionId);
}

function notify(sessionId: string): void {
  for (const fn of [...listeners]) {
    try {
      fn(sessionId);
    } catch (err) {
      // One listener that throws must not leave the others on a stale review —
      // and must never stop an answer that has already gone to the CLI from
      // being drawn as sent.
      console.error('review listener failed', err);
    }
  }
}

function disposeEditor(diffId: string): void {
  const mounted = editors.get(diffId);
  if (!mounted) return;
  editors.delete(diffId);
  mounted.editor.destroy();
  // With the host goes the search bar cached on it, which would otherwise be
  // handed to the next editor built into a recycled box.
  mounted.host.remove();
}

// ── drawing ───────────────────────────────────────────────────────────────────

/**
 * Draw the header and the list always; the merge view only when it can be
 * measured. See the note at the top on why the editor waits.
 */
function paint(): void {
  if (!mounts) return;

  const state = reviewFor(shownSessionId);
  if (state === null || isReviewEmpty(state)) {
    bodyEl.textContent = '';
    filesEl.textContent = '';
    filesEl.hidden = true;
    return;
  }

  drawHeader(state);
  drawFileList(state);

  if (!surfaceVisible()) {
    dirty = true;
    return;
  }
  dirty = false;
  drawBody(state);
}

function drawHeader(state: ReviewState): void {
  sessionEl.textContent = sessionName(state.sessionId);

  const item = currentItem(state);
  fileEl.textContent = item === null ? '' : basename(item.edit.filePath);
  fileEl.title = item?.edit.filePath ?? '';

  progressEl.textContent = progressLabel(state);

  // The controls answer the file on screen, so they go when it has been
  // answered — a live Accept over an edit the CLI has already been told about
  // is an offer the app cannot keep.
  const answerable = item !== null && item.outcome === null;
  rejectBtn.hidden = !answerable;
  acceptBtn.hidden = !answerable;

  // Only worth offering while it means more than the button beside it.
  const waiting = pendingProposals(state).length;
  acceptAllBtn.hidden = waiting < 2;
  acceptAllBtn.textContent = `Accept all ${waiting}`;
}

function drawFileList(state: ReviewState): void {
  // One file is its own list: the header already names it.
  filesEl.hidden = state.items.length < 2;
  filesEl.textContent = '';
  if (filesEl.hidden) return;

  for (const item of state.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'code-review-row';
    if (item.edit.diffId === state.currentDiffId) row.classList.add('current');
    row.classList.add(`code-review-${item.outcome === null ? 'waiting' : outcomeTone(item.outcome)}`);
    row.dataset.diffId = item.edit.diffId;
    row.title = item.edit.filePath;

    row.append(
      span('code-review-mark'),
      span('code-review-row-name', basename(item.edit.filePath)),
      span('code-review-row-dir', dirLabel(item.edit.filePath)),
    );
    filesEl.appendChild(row);
  }
}

function drawBody(state: ReviewState): void {
  const item = currentItem(state);

  // Detached, not destroyed: moving between the files of one review keeps every
  // merge view, and with it anything the user has typed into the edited side.
  for (const child of [...bodyEl.children]) child.remove();
  if (item === null) return;

  const mounted = editors.get(item.edit.diffId) ?? buildEditor(item.edit);
  bodyEl.appendChild(mounted.host);
}

function buildEditor(edit: ProposedEdit): MountedEditor {
  const host = document.createElement('div');
  host.className = 'code-review-diff';
  // Attached before the editor is built, because that is when CodeMirror
  // measures it — see the note at the top of this file.
  bodyEl.appendChild(host);

  const editor = layout === 'inline'
    ? createUnifiedMergeViewer(host, edit.oldContent, edit.newContent, edit.filePath) as ReviewEditor
    : createMergeViewer(host, edit.oldContent, edit.newContent, edit.filePath) as ReviewEditor;

  // Clicking the diff should put the caret in it, as it does in the file panel:
  // the per-hunk accept and reject controls are keyboard-reachable from there.
  editor.dom.addEventListener('click', () => editor.dom.focus());

  const mounted = { host, editor, layout };
  editors.set(edit.diffId, mounted);
  return mounted;
}

/**
 * Whether a merge view built now would be able to measure itself.
 *
 * The code area is hidden by `showViewer` with `display: none`, and the review
 * body by the content mode; either one makes every measurement zero.
 */
function surfaceVisible(): boolean {
  return mounts !== null && !mounts.body.hidden && codeArea.style.display !== 'none';
}

// ── small helpers ─────────────────────────────────────────────────────────────

function sessionName(sessionId: string): string {
  const session = sessionMap.get(sessionId) ?? openSessions.get(sessionId)?.session;
  if (!session) return sessionId;
  return cleanDisplayName(session.name || session.aiTitle || session.summary) || sessionId;
}

function outcomeTone(outcome: ReviewOutcome): string {
  return outcome === 'reject' ? 'rejected' : 'accepted';
}

function span(className: string, text = ''): HTMLElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function button(id: string, text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.id = id;
  element.className = 'code-review-btn';
  element.textContent = text;
  element.addEventListener('click', onClick);
  return element;
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Enough of the folder to tell two files of the same name apart.
 *
 * The nearest two segments, not the whole path: the row is a chip and the point
 * of the folder here is disambiguation, not location — the full path is on the
 * row's tooltip. Trimmed in script rather than with `direction: rtl`, which
 * would put a leading `/` on the wrong end of the box.
 */
function dirLabel(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').slice(0, -1).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
}
