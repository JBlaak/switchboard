/**
 * The code area: a file on screen with no session behind it.
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
 */
import { showViewer } from '../panel/viewers';
import { setMainMode } from '../../app/main-mode';
import { showTerminalArea } from '../../app/tab-router';
import { absolutePathFor, breadcrumbSegments } from './code-path';
import { codeArea } from '../../lib/dom';
import { codePanel } from '../panel/panels';

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
}

/** How long the "changed on disk" note stays up after a reload. */
const NOTE_MS = 4000;

let crumbsEl: HTMLElement | null = null;
let noteEl: HTMLElement | null = null;
let readOnlyEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let noteTimer: ReturnType<typeof setTimeout> | undefined;

/** The absolute path of the file on screen, or null while the area is closed. */
let openPath: string | null = null;

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

  codeArea.insertBefore(header, codePanel.editorEl);

  // What this half shows before a file has been picked. It exists because the
  // flip can bring the code side up on its own: ⌘J is a request for the space,
  // not for a particular file, and an empty panel with no explanation reads as
  // a broken view rather than an empty one.
  emptyEl = document.createElement('div');
  emptyEl.id = 'code-area-empty';
  emptyEl.textContent = 'Pick a file from Changes or the project tree.';
  codeArea.insertBefore(emptyEl, codePanel.editorEl.nextSibling);
  showEmptyState(true);

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
  if (readOnlyEl) readOnlyEl.hidden = opts.readOnly === false;
  openPath = filePath;

  // The panel builds its editor once and an `auto` language panel picks the mode
  // while doing so, so reusing it for the next file would highlight Python as
  // TypeScript. Rebuilding per open is what the file panel does per tab, for the
  // same reason.
  codePanel.destroy();
  showEmptyState(false);
  showViewer('code');
  codePanel.open(crumbs[crumbs.length - 1] ?? filePath, filePath, opts.content);
}

/**
 * Close the code area and put the terminal back.
 *
 * Destroying the panel is what unregisters the file watch — the watch is
 * registered by `open()` and released by `destroy()`, so leaving the editor
 * standing would leave main watching a file nobody is looking at. The next open
 * rebuilds it.
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
  clearNote();
  codePanel.destroy();
  showEmptyState(true);
  setMainMode('talk');
  showTerminalArea();
}

/** The panel and the "pick a file" line are alternatives, never both. */
function showEmptyState(empty: boolean): void {
  if (emptyEl) emptyEl.hidden = !empty;
  codePanel.editorEl.style.display = empty ? 'none' : '';
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
