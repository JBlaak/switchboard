/**
 * The code area: what the code half of the window is showing.
 *
 * The existing file panel cannot do this. It is keyed by session — its state is
 * created per session id and only rendered while that session is the panel's
 * current one — so a project-scoped tree, which has no session to name, would
 * open a file into a panel nothing ever shows. The code area is a viewer in its
 * own right, a sibling of `#terminal-area` under `#main`, and `showViewer`
 * treats it like any other one-of-N panel.
 *
 * It fetches nothing. The Files tab reads the file (`window.api.readProjectFile`)
 * and calls `openFileInCodeArea` with the content, which keeps this module free
 * of the question of what a project is allowed to read.
 *
 * Being a sibling of the terminal area rather than something inside it is the
 * point: the `Talk | Split | Code` control moves two axes — the terminal with
 * the split panel open or closed, or the code area instead of the terminal —
 * and only one of those axes lives inside `#terminal-area`. `app/main-mode.ts`
 * owns the pairing; this module owns what is in the panel, and knows nothing
 * about which half currently has the window.
 *
 * **What it is showing is a mode of its own.** A file has a breadcrumb; a review
 * has a session asking, a count of what is still waiting, and the two buttons
 * that answer the CLI; the whole-worktree diff has its own header again, and its
 * own scroll. They are one enum and one table rather than a flag per surface,
 * because every one of them is "this region up, that region down" and a pair of
 * booleans goes wrong the first time a third thing is added. Adding a mode is a
 * row in `SURFACES` and a branch in the two places that name one.
 *
 * **The diff is where the half rests.** Invariant 6: the code side opens on the
 * whole diff, not on one file, so `empty` is now only the answer when no project
 * is scoped at all. A file the reader picked outranks it, and a review outranks
 * both — the ordering lives in `rest()` and `syncToActiveSession()`.
 */
import { showViewer } from '../panel/viewers';
import { getMainMode, setMainMode, onMainModeChange } from '../../app/main-mode';
import { showTerminalArea } from '../../app/tab-router';
import { absolutePathFor, breadcrumbSegments } from './code-path';
import { changesRoot } from '../files/changes-list';
import { codeArea } from '../../lib/dom';
import { codePanel } from '../panel/panels';
import {
  changedLinesFor, diffHasPath, hideDiffView, installDiffView, paintDiffModeControl,
  refreshDiffView, showDiffView,
} from './diff-view';
import {
  hasPendingReview, hasReview, installReviewView, onReviewChange, proposeEdit, refreshReview,
  showReviewFor,
} from './review-view';
import { view } from '../../state/session-store';
import type { ProposedEdit } from './review-view';
import type { WholeFileRequest } from './diff-view';

/**
 * What the code half is showing.
 *
 * `empty` is the honest answer to ⌘J with nothing scoped and nothing picked:
 * the flip asks for the space, not for a particular file. `diff` is the whole
 * worktree in one scroll and is what the half *rests* on once a project is
 * scoped — invariant 6 — with `file` as the second flip inside this half for
 * reading one of those files whole.
 */
export type CodeContent = 'empty' | 'file' | 'review' | 'diff';

/** Which regions of the area one mode wants. */
interface CodeSurfaces {
  /** The breadcrumb in the header — a file's identity. */
  crumbs: boolean;
  /** The review's header strip and its surface below. */
  review: boolean;
  /** The whole-diff header strip and its scroll below. */
  diff: boolean;
  /** The shared viewer panel's editor. */
  editor: boolean;
  /** The "pick a file" line. */
  empty: boolean;
}

const SURFACES: Record<CodeContent, CodeSurfaces> = {
  empty:  { crumbs: false, review: false, diff: false, editor: false, empty: true  },
  file:   { crumbs: true,  review: false, diff: false, editor: true,  empty: false },
  review: { crumbs: false, review: true,  diff: false, editor: false, empty: false },
  diff:   { crumbs: false, review: false, diff: true,  editor: false, empty: false },
};

/** Which of a changed file's two readings the header's `Diff | File` is on. */
type FileReading = 'diff' | 'file';

/** What `openFileInCodeArea` needs to show a file. */
export interface CodeAreaFile {
  /** The root the breadcrumb is relative to. */
  worktreePath: string;
  /** The file, relative to that root. An absolute path inside it also works. */
  relPath: string;
  content: string;
  /**
   * Whether the buffer is a view rather than a draft. Defaults to true, and
   * true is all the panel can currently honour: `codePanel` is built without an
   * `onSave`, so nothing typed here can be persisted. A caller passing false
   * only drops the header's badge — it does not make the panel writable — so
   * the Files tab should keep passing nothing until there is a save path.
   */
  readOnly?: boolean;
  /**
   * Lines of this file the diff attributes to a change, 1-based.
   *
   * Drawn as green bars down the gutter, so flipping `Diff → File` does not
   * make the diff vanish the moment you read around it. Left out by a caller
   * that has not bought the file's patch: the code area asks the diff surface
   * for them itself and marks them when they arrive.
   */
  changedLines?: readonly number[];
}

/** How long the "changed on disk" note stays up after a reload. */
const NOTE_MS = 4000;

let crumbsEl: HTMLElement | null = null;
let noteEl: HTMLElement | null = null;
let readOnlyEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let reviewHeadEl: HTMLElement | null = null;
let reviewBodyEl: HTMLElement | null = null;
let diffHeadEl: HTMLElement | null = null;
let diffBodyEl: HTMLElement | null = null;
let readingEl: HTMLElement | null = null;
let readingButtons: Map<FileReading, HTMLButtonElement> | null = null;
let changedEl: HTMLElement | null = null;
let noteTimer: ReturnType<typeof setTimeout> | undefined;

let content: CodeContent = 'empty';
/** Whether the file on screen has its read-only badge — only `file` shows it. */
let readOnlyBadge = true;

/**
 * Set while the file on screen is one the user picked themselves.
 *
 * A session waiting on an answer otherwise claims this half back on the next
 * flip, which is right when the review arrived while the user was elsewhere and
 * wrong the moment they deliberately open a file instead. Cleared by the next
 * thing the CLI proposes, so the claim comes back with the next request rather
 * than being given up for good — and cleared by a session switch, because it is
 * a fact about reading *this* session's code and not a standing preference.
 */
let filePicked = false;

/** The session the half was last put in step with, to notice a switch. */
let syncedSessionId: string | null = null;

/** The absolute path of the file on screen, or null while none is open. */
let openPath: string | null = null;

/** The same file as the diff spells it, for the `Diff | File` flip to go back. */
let openRelPath: string | null = null;
let openWorktree: string | null = null;

/**
 * Build the code area's header and start listening for external edits.
 *
 * The header goes *below* the viewer panel's toolbar, not above it. The toolbar
 * is what `_chrome.scss` knows about: it is the window's drag region and, on
 * Windows and Linux, the bar inset to clear the overlay window controls. A
 * second bar above it would put an element chrome has never heard of in the top
 * strip, making the window undraggable in this view and letting the controls
 * land on the breadcrumb.
 */
export function installCodeArea(): void {
  if (crumbsEl) return;

  const header = document.createElement('div');
  header.id = 'code-area-header';

  // No back button: the way out is the folded conversation strip along the
  // bottom, or ⌘J. A second control that also left this half would be a second
  // answer to "where did my session go", and only one of them would have kept
  // the scroll position.

  crumbsEl = document.createElement('div');
  crumbsEl.id = 'code-area-crumbs';
  header.appendChild(crumbsEl);

  readOnlyEl = document.createElement('span');
  readOnlyEl.id = 'code-area-readonly';
  readOnlyEl.textContent = 'read-only';
  readOnlyEl.title = 'This panel does not save. Copy the content to edit it elsewhere.';
  readOnlyEl.hidden = true;
  header.appendChild(readOnlyEl);

  noteEl = document.createElement('span');
  noteEl.id = 'code-area-note';
  noteEl.hidden = true;
  header.appendChild(noteEl);

  // The review's half of the header, filled by the review view and shown only
  // in that mode. It shares the bar with the breadcrumb rather than adding a
  // second one, for the chrome reason above.
  // Which reading of a changed file is on screen. Only ever up for a file the
  // diff has something to say about: a file with one reading has no flip.
  readingEl = document.createElement('div');
  readingEl.id = 'code-area-views';
  readingEl.className = 'sb-segmented';
  readingEl.setAttribute('role', 'group');
  readingEl.setAttribute('aria-label', 'Which reading of this file');
  readingEl.hidden = true;
  readingButtons = new Map();
  for (const reading of ['diff', 'file'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-segment';
    button.textContent = reading === 'diff' ? 'Diff' : 'File';
    button.title = reading === 'diff'
      ? 'Back to the whole diff, at this file'
      : 'This file whole, with the changed lines marked';
    button.addEventListener('click', () => pickReading(reading));
    readingEl.appendChild(button);
    readingButtons.set(reading, button);
  }
  header.appendChild(readingEl);

  // How much of the file on screen this diff is responsible for. Green,
  // because it is the same fact the gutter bars beside it are stating.
  changedEl = document.createElement('span');
  changedEl.id = 'code-area-changed';
  changedEl.hidden = true;
  header.appendChild(changedEl);

  reviewHeadEl = document.createElement('div');
  reviewHeadEl.id = 'code-area-review';
  reviewHeadEl.hidden = true;
  header.appendChild(reviewHeadEl);

  // The whole diff's own strip, shown in place of the breadcrumb. It shares
  // this bar rather than adding a second one, for the chrome reason above.
  diffHeadEl = document.createElement('div');
  diffHeadEl.id = 'code-area-diff';
  diffHeadEl.hidden = true;
  header.appendChild(diffHeadEl);

  codeArea.insertBefore(header, codePanel.editorEl);

  // What this half shows before a file has been picked. It exists because the
  // flip can bring the code side up on its own: ⌘J is a request for the space,
  // not for a particular file, and an empty panel with no explanation reads as
  // a broken view rather than an empty one.
  emptyEl = document.createElement('div');
  emptyEl.id = 'code-area-empty';
  emptyEl.textContent = 'Pick a file from Changes or the project tree.';
  codeArea.insertBefore(emptyEl, codePanel.editorEl.nextSibling);

  reviewBodyEl = document.createElement('div');
  reviewBodyEl.id = 'code-review';
  reviewBodyEl.hidden = true;
  codeArea.appendChild(reviewBodyEl);
  installReviewView({ header: reviewHeadEl, body: reviewBodyEl });

  diffBodyEl = document.createElement('div');
  diffBodyEl.id = 'code-diff';
  diffBodyEl.hidden = true;
  codeArea.appendChild(diffBodyEl);
  installDiffView({ header: diffHeadEl, body: diffBodyEl }, {
    onOpenFile: showWholeFile,
    onPickMode: setMainMode,
  });

  setCodeContent('empty');

  // A review is per session and this half is not, so the two have to be kept in
  // step: the mode is re-applied at the end of every `showSession`, which is
  // the one point at which a session is definitely the one on screen.
  onMainModeChange(mode => {
    syncToActiveSession();
    // The flip may have just made this half visible, and a merge view can only
    // be built once it can be measured.
    refreshReview();
    // Same reason as the review's refresh: a scroll built while this half was
    // folded could not measure itself, and now it can.
    refreshDiffView();
    // The diff header carries its own copy of the three-state control, because
    // in `code` mode the terminal header that normally holds it is not up.
    paintDiffModeControl(mode);
  });

  // And when a review changes under us — the CLI withdrawing its last diff is
  // what takes this half back out of review mode.
  onReviewChange(sessionId => {
    if (sessionId === view.activeSessionId) syncToActiveSession();
  });

  // ViewerPanel already watches the open file and re-reads it when the watcher
  // fires (see its `_onFileChanged`), and for a read-only buffer that silent
  // refresh is the right behaviour — there is nothing of the user's to lose, so
  // a banner asking permission to reload would be asking about content that has
  // already been replaced. What it cannot do is *say* so, which is all this
  // listener adds: a line in the header, dim and self-clearing, so an edit made
  // in an editor elsewhere does not look like the panel drifting.
  window.api.onFileChanged((changedPath) => {
    if (changedPath === openPath) showNote('Reloaded — changed on disk');
  });
}

/** What the code half is showing right now. */
export function codeContent(): CodeContent {
  return content;
}

/**
 * Show a file in the main area, in place of the terminal.
 *
 * The panel is shown before the content is handed over: CodeMirror measures its
 * host when the editor is created, and creating it inside a `display: none`
 * container gives a first paint with no gutter width.
 */
export function openFileInCodeArea(opts: CodeAreaFile): void {
  const crumbs = breadcrumbSegments(opts.worktreePath, opts.relPath);
  const filePath = absolutePathFor(opts.worktreePath, opts.relPath);

  renderCrumbs(crumbs);
  clearNote();
  readOnlyBadge = opts.readOnly !== false;
  openPath = filePath;
  openRelPath = opts.relPath;
  openWorktree = opts.worktreePath;
  filePicked = true;

  // The panel builds its editor once and an `auto` language panel picks the mode
  // while doing so, so reusing it for the next file would highlight Python as
  // TypeScript. Rebuilding per open is what the file panel does per tab, for the
  // same reason.
  codePanel.destroy();
  setCodeContent('file');
  showViewer('code');
  codePanel.open(crumbs[crumbs.length - 1] ?? filePath, filePath, opts.content, {
    changedLines: opts.changedLines,
  });

  markChanged(opts.changedLines ?? null);
  paintReading('file', opts.relPath);
  // A caller that had no patch to hand — the Changes list, the file tree —
  // still gets the bars, a moment later and without rebuilding the editor. The
  // path is re-checked on the way back because the reader may have moved on.
  if (opts.changedLines === undefined
    && opts.worktreePath === changesRoot() && diffHasPath(opts.relPath)) {
    const wanted = opts.relPath;
    void changedLinesFor(wanted).then(lines => {
      if (lines === null || openRelPath !== wanted) return;
      codePanel.markChangedLines(lines);
      markChanged(lines);
    });
  }
}

/**
 * Show the whole worktree's diff — every changed file in one scroll.
 *
 * `filePicked` is set for the same reason `openFileInCodeArea` sets it: this is
 * a deliberate choice about what to read, and a review that arrived while the
 * user was elsewhere must not take the half back out from under it on the next
 * flip. The next thing the CLI proposes clears the flag, so the claim comes
 * back with the next request rather than being given up for good.
 */
export function openDiffInCodeArea(focusPath?: string): void {
  codePanel.destroy();
  clearNote();
  filePicked = true;
  setCodeContent('diff');
  showViewer('code');
  // After the region is up: the scroll has to be measurable before anything
  // can ask which of its sections are near the viewport.
  showDiffView(focusPath);
  paintDiffModeControl(getMainMode());
}

/** What the diff surface asks for when someone clicks `Open file` on a header. */
function showWholeFile(request: WholeFileRequest): void {
  const content = request.contentAtBase;
  if (content !== undefined) {
    openFileInCodeArea({
      worktreePath: request.worktreePath,
      relPath: request.relPath,
      content,
      changedLines: [],
    });
    showNote('The copy at the base — this file is gone from the worktree');
    return;
  }

  void window.api.readProjectFile(request.worktreePath, request.relPath).then(result => {
    if (typeof result?.content !== 'string') {
      showNote(result?.error ?? 'Could not read this file');
      return;
    }
    openFileInCodeArea({
      worktreePath: request.worktreePath,
      relPath: request.relPath,
      content: result.content,
      changedLines: request.changedLines,
    });
  });
}

/** The `Diff | File` flip, inside this half. */
function pickReading(reading: FileReading): void {
  if (reading === 'file') return;
  const relPath = openRelPath;
  if (relPath === null) return;
  openDiffInCodeArea(relPath);
}

/**
 * Show the control only for a file that genuinely has two readings.
 *
 * Both halves of that: the file has to be in the diff, *and* the diff has to be
 * of the worktree the file came from. A file opened out of another project's
 * tree shares nothing with this scroll but a relative path.
 */
function paintReading(reading: FileReading, relPath: string | null): void {
  if (!readingEl || !readingButtons) return;
  const twoWays = relPath !== null && openWorktree === changesRoot() && diffHasPath(relPath);
  readingEl.hidden = !twoWays;
  for (const [name, button] of readingButtons) {
    button.classList.toggle('on', name === reading);
    button.setAttribute('aria-pressed', String(name === reading));
  }
}

function markChanged(lines: readonly number[] | null): void {
  if (!changedEl) return;
  const count = lines?.length ?? 0;
  changedEl.hidden = count === 0;
  changedEl.textContent = count === 0
    ? '' : `${count} line${count === 1 ? '' : 's'} changed here`;
}

/**
 * A session is asking to change a file: put it on the review surface.
 *
 * Always recorded, whoever it belongs to — a request that arrived while the
 * user was in another session is still parked in the bridge, and dropping it
 * here would leave the CLI waiting on a review nobody can reach. Only drawn
 * when it belongs to the session on screen, because the surface shows one
 * session's review and drawing another's under this name is the mix-up the
 * per-session state exists to prevent.
 *
 * Bringing the window round to it is *not* decided here. `app/ipc-listeners.ts`
 * owns that, because whether a request may take the window depends on what the
 * user is doing, which is a question about the app rather than about this half.
 */
export function openReviewInCodeArea(sessionId: string, edit: ProposedEdit): void {
  proposeEdit(sessionId, edit);
  if (sessionId !== view.activeSessionId) return;

  // The next proposal outranks a file the user opened by hand: something is
  // waiting on them again.
  filePicked = false;
  showReviewFor(sessionId);
  setCodeContent('review');
}

/**
 * Close the code area and put the terminal back.
 *
 * Destroying the panel is what unregisters the file watch — the watch is
 * registered by `open()` and released by `destroy()`, so leaving the editor
 * standing would leave main watching a file nobody is looking at. The next open
 * rebuilds it.
 *
 * A review is *not* torn down with it and nothing is answered: a diff the CLI is
 * still parked on outlives the closing of a panel, exactly as a folded split
 * outlives ⌘J. The surface comes back with its list intact.
 *
 * Not what ⌘J does: the flip folds this half and keeps it, and closing is the
 * heavier gesture that throws the buffer away. The mode is dropped to `talk`
 * first so the flip does not immediately put back what has just been closed.
 */
export function closeCodeArea(): void {
  // Only the visible panel is ours to close: another viewer may have taken the
  // main area, and restoring the terminal from under it would be a surprise.
  if (codeArea.style.display === 'none') return;

  openPath = null;
  openRelPath = null;
  openWorktree = null;
  filePicked = false;
  clearNote();
  codePanel.destroy();
  setCodeContent('empty');
  setMainMode('talk');
  showTerminalArea();
}

/**
 * Put the regions where one mode wants them.
 *
 * Every mode goes through here, so "which regions are up" is answered in one
 * table rather than at each call site — which is what makes a fourth mode a row
 * rather than an audit of every branch in the file.
 */
function setCodeContent(next: CodeContent): void {
  content = next;
  const want = SURFACES[next];

  if (crumbsEl) crumbsEl.hidden = !want.crumbs;
  if (readOnlyEl) readOnlyEl.hidden = !(want.crumbs && readOnlyBadge);
  if (reviewHeadEl) reviewHeadEl.hidden = !want.review;
  if (reviewBodyEl) reviewBodyEl.hidden = !want.review;
  if (diffHeadEl) diffHeadEl.hidden = !want.diff;
  if (diffBodyEl) diffBodyEl.hidden = !want.diff;
  if (emptyEl) emptyEl.hidden = !want.empty;
  codePanel.editorEl.style.display = want.editor ? '' : 'none';

  // Both are about the file on screen, so they mean nothing over anything else.
  if (!want.crumbs) {
    clearNote();
    if (readingEl) readingEl.hidden = true;
    if (changedEl) changedEl.hidden = true;
  }

  // One place, so a surface that takes the half cannot forget to tell the diff
  // it is no longer the one being read — and a new answer from git then stops
  // redrawing a scroll nobody can see.
  if (!want.diff) hideDiffView();

  // Entering review, the merge view may now be buildable; leaving it, this is a
  // no-op. Either way the review draws itself rather than being drawn from here.
  if (want.review) refreshReview();
}

/**
 * Follow the session the user is now in.
 *
 * A session still holding the CLI takes this half: that is the whole point of
 * the review surface, and invariant 4 — nothing goes quiet — means the request
 * has to be findable from the session it came from. A review that has been
 * emptied by the CLI gives the half back to whatever was here before.
 */
function syncToActiveSession(): void {
  const sessionId = view.activeSessionId;

  // A file opened while reading one session says nothing about the next one,
  // and leaving the flag standing would hide the review the user has just
  // switched to.
  if (sessionId !== syncedSessionId) {
    syncedSessionId = sessionId;
    filePicked = false;
  }

  if (sessionId !== null && hasPendingReview(sessionId) && !filePicked) {
    showReviewFor(sessionId);
    setCodeContent('review');
    return;
  }

  if (content === 'review' && !hasReview(sessionId)) {
    rest();
    return;
  }

  // Invariant 6: with nothing else claiming the half, this is where it lands.
  // Only ever from `empty` — a file or a diff already on screen is what the
  // reader last asked for, and re-deciding it on every flip would undo them.
  if (content === 'empty') rest();
}

/**
 * What the half shows when nothing has claimed it.
 *
 * The file that was open, then the whole diff, then the line that admits there
 * is nothing to show. The diff comes before the apology because "the code side
 * opens on the whole diff" is the invariant, and a scoped worktree always has
 * one — even an empty one, which says so in its own words rather than in the
 * generic placeholder's.
 */
function rest(): void {
  if (openPath !== null) {
    setCodeContent('file');
    return;
  }
  if (changesRoot() !== null) {
    setCodeContent('diff');
    showDiffView();
    return;
  }
  setCodeContent('empty');
}

/**
 * Draw `src / renderer / app.ts`, with the file itself as the strong crumb.
 *
 * The directories go inside one shrinkable box and the file name stays outside
 * it, so a path too long for the bar loses its leading folders rather than the
 * one segment the user is actually looking at.
 */
function renderCrumbs(crumbs: string[]): void {
  const host = crumbsEl;
  if (!host) return;
  host.textContent = '';

  const dirs = document.createElement('span');
  dirs.className = 'code-crumb-dirs';
  for (const segment of crumbs.slice(0, -1)) {
    const crumb = document.createElement('span');
    crumb.className = 'code-crumb';
    crumb.textContent = segment;
    dirs.appendChild(crumb);

    const separator = document.createElement('span');
    separator.className = 'code-crumb-sep';
    separator.textContent = '/';
    dirs.appendChild(separator);
  }
  host.appendChild(dirs);

  const name = crumbs[crumbs.length - 1];
  if (name === undefined) return;
  const file = document.createElement('span');
  file.className = 'code-crumb code-crumb-file';
  file.textContent = name;
  host.appendChild(file);
}

function showNote(text: string): void {
  if (!noteEl) return;
  noteEl.textContent = text;
  noteEl.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => clearNote(), NOTE_MS);
}

function clearNote(): void {
  clearTimeout(noteTimer);
  if (noteEl) noteEl.hidden = true;
}
