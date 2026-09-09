/**
 * The Files tab's tree: the scoped project's working directory, one level at a
 * time.
 *
 * The drawing and the IPC. Every decision about what the tree contains, which
 * rows are on screen and what a query leaves standing is in
 * `file-tree-model.ts`, which has no DOM in it and is tested directly.
 *
 * Three things about this module are load-bearing.
 *
 * **Every listing costs a process.** `listDir` is an IPC round trip and a
 * `git check-ignore` spawn in the main process, and nothing is cached over
 * there. So each directory is read once and the answer stays on its node (see
 * `FileNode.children`), and an expand waits out `EXPAND_MS` before it fetches —
 * a folder opened and shut again while the user scans the list never costs
 * anything.
 *
 * **The listing is taken as given.** The main process has already ordered the
 * entries and removed what git ignores; re-sorting or re-filtering here would
 * only be able to disagree with it. A symlink arrives as a leaf and is drawn as
 * one, whatever it points at.
 *
 * **Everything a user can cause is in-band.** A directory that cannot be read
 * comes back `{ entries: [], unreadable: true }` and a file that cannot be
 * opened comes back `{ error }`, and both are printed where they happened. Only
 * a path escaping the worktree throws, which arrives as the `{ ok: false }`
 * envelope every invoke can answer with — hence the `Array.isArray` guard
 * before anything walks a listing.
 *
 * Where a clicked file is *shown* is not this module's business: `files-tab.ts`
 * passes that in. That keeps the tree out of the import cycle it would
 * otherwise sit in — `app/search.ts` drives the filter from here, and the code
 * area imports the tab router, which imports the search.
 */
import {
  applyListing, canExpand, createRoot, filterRows, nameHighlight, toggle,
} from './file-tree-model';
import { ICONS } from '../../lib/icons';
import { filesContent } from '../../lib/dom';
import { getScope } from '../../state/scope-store';
import { view } from '../../state/session-store';
import type { FileNode, FileRow, MatchRange } from './file-tree-model';

/** A file the user clicked, read and ready to show. */
export interface OpenedFile {
  /** The directory the tree is rooted at — the scope's worktree or project. */
  worktreePath: string;
  /** Forward-slashed, relative to that root. */
  relPath: string;
  content: string;
}

/**
 * How long an expand waits before it fetches.
 *
 * Long enough to swallow a double click and a run down the list with the arrow
 * of a folder being opened and shut, short enough that a deliberate click does
 * not feel like it was ignored. The skeleton rows go up immediately either way,
 * so the wait is invisible unless it is cancelled.
 */
const EXPAND_MS = 120;

/**
 * The leaf glyph, at the 14px the folder icon is drawn at.
 *
 * Not in `lib/icons.ts` because nothing else draws a file: that table is for
 * glyphs more than one surface shares, and a second copy of it here would be
 * the thing worth avoiding, not one entry that has no other caller.
 */
const LEAF_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v5h6"></path></svg>';

/** The root the tree is showing, and the directory it is rooted at. */
let root: FileNode | null = null;
let rootPath: string | null = null;

/** The current filter. Held here, not in the search box, so a redraw keeps it. */
let query = '';

/** The row the user last opened, so the tree says where they are. */
let selectedPath: string | null = null;

/** relPath → why the last attempt to open it failed, printed on its row. */
const readErrors = new Map<string, string>();

/** relPath → the node it is drawn from, rebuilt on every draw for the clicks. */
const drawnNodes = new Map<string, FileNode>();

/** relPath → the pending fetch for that directory, so a collapse can cancel it. */
const expandTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Where a clicked file is shown; supplied by `files-tab.ts`. */
let showFile: (file: OpenedFile) => void = () => {};

/** Wire the tree's one click handler up. Does not draw: the tab does that. */
export function installFileTree(onOpenFile: (file: OpenedFile) => void): void {
  showFile = onOpenFile;
  filesContent.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const rowEl = target?.closest<HTMLElement>('.file-row');
    const path = rowEl?.dataset.path;
    if (path === undefined) return;
    const node = drawnNodes.get(path);
    if (node) void activate(node);
  });
}

/**
 * Draw the tree for whatever is in scope, fetching the root if this is the
 * first look at it.
 *
 * Called every time the tab comes up rather than once, because the scope may
 * have changed under it while another tab was showing — `resetFileTree` drops
 * the tree in that case and leaves the refetch to whenever the user comes back.
 */
export function showFileTree(): void {
  const path = scopeRoot();
  if (path !== rootPath) {
    rootPath = path;
    root = path === null ? null : createRoot();
  }
  if (root !== null && root.children === null && !root.loading) {
    // No debounce for the root: nobody toggled it, so there is nothing to
    // change their mind about.
    void load(root);
  }
  draw();
}

/**
 * The directory the tree is rooted at: the scoped worktree, or the project
 * itself when the scope names no checkout. Null is "All", which is no place.
 */
function scopeRoot(): string | null {
  const scope = getScope();
  return scope === null ? null : scope.worktreePath ?? scope.projectPath;
}

/**
 * Forget the tree; the scope it was showing is no longer the one in effect.
 *
 * The whole tree goes rather than being diffed against the new scope: every
 * path in it is relative to a root that has changed, so there is nothing in it
 * worth keeping. Only redrawn when the tab is up — a scope change while the
 * session list is showing must not spend an IPC round trip and a process on a
 * tree nobody is looking at.
 *
 * A scope change that lands on the same directory is not one: `scope-store`
 * also notifies when the *worktrees* of the scoped project change, and throwing
 * the tree away for that would collapse the branch the user is working in
 * because a checkout appeared somewhere else.
 */
export function resetFileTree(): void {
  if (scopeRoot() === rootPath) return;

  root = null;
  rootPath = null;
  selectedPath = null;
  readErrors.clear();
  drawnNodes.clear();
  for (const timer of expandTimers.values()) clearTimeout(timer);
  expandTimers.clear();
  if (view.activeTab === 'files') showFileTree();
}

/** Narrow the tree to `next`, or show all of it again for an empty query. */
export function setFileTreeQuery(next: string): void {
  if (next === query) return;
  query = next;
  if (root !== null) draw();
}

/**
 * Drop the query without redrawing — for a tab switch.
 *
 * Unconditional, because the box has already been emptied by the time this is
 * called and coming back to the tab draws from scratch anyway.
 */
export function forgetFileTreeQuery(): void {
  query = '';
}

/**
 * A row was clicked: open the folder, or read the file and hand it over.
 *
 * A failed read is remembered against the path and printed on the row. Doing
 * nothing would be indistinguishable from a click that missed, and the usual
 * causes — a binary, a file too large to send, one deleted since the listing —
 * are all worth a sentence.
 */
async function activate(node: FileNode): Promise<void> {
  if (canExpand(node)) {
    if (toggle(node)) scheduleLoad(node);
    else cancelLoad(node);
    draw();
    return;
  }
  if (rootPath === null) return;

  const worktreePath = rootPath;
  selectedPath = node.path;
  readErrors.delete(node.path);
  draw();

  const result = await window.api.readProjectFile(worktreePath, node.path);
  if (typeof result?.content === 'string') {
    showFile({ worktreePath, relPath: node.path, content: result.content });
    return;
  }
  readErrors.set(node.path, result?.error ?? 'Could not read this file');
  draw();
}

/** Fetch a directory's listing once the user has stayed on their decision. */
function scheduleLoad(node: FileNode): void {
  if (node.children !== null || node.loading) return;
  node.loading = true;
  cancelTimer(node);
  expandTimers.set(node.path, setTimeout(() => {
    expandTimers.delete(node.path);
    void load(node);
  }, EXPAND_MS));
}

/** The folder was shut again before the fetch went out. */
function cancelLoad(node: FileNode): void {
  if (!expandTimers.has(node.path)) return;
  cancelTimer(node);
  node.loading = false;
}

function cancelTimer(node: FileNode): void {
  const timer = expandTimers.get(node.path);
  if (timer !== undefined) clearTimeout(timer);
  expandTimers.delete(node.path);
}

/**
 * One directory, from the main process.
 *
 * The scope is re-checked on the way back: the answer describes a root that may
 * have been swapped out while it was in flight, and hanging it on the tree that
 * replaced it would show one project's folders inside another's.
 */
async function load(node: FileNode): Promise<void> {
  if (rootPath === null) return;
  const forRoot = rootPath;
  node.loading = true;
  draw();

  const listing = await window.api.listDir(forRoot, node.path);
  if (rootPath !== forRoot) return;

  // The `{ ok: false, error }` envelope every invoke can answer with. Only a
  // path leaving the worktree gets here, which the tree cannot build — so it is
  // reported as an unreadable directory rather than given its own state.
  applyListing(node, Array.isArray(listing?.entries)
    ? listing
    : { entries: [], unreadable: true });
  draw();
}

// ── drawing ───────────────────────────────────────────────────────────────────

function draw(): void {
  filesContent.textContent = '';
  drawnNodes.clear();

  if (root === null) {
    filesContent.appendChild(note('Pick a project on the rail'));
    return;
  }

  const rows = filterRows(root, query);
  const list = document.createElement('div');
  list.className = 'file-tree';
  for (const row of rows) list.appendChild(rowElement(row));
  filesContent.appendChild(list);

  if (rows.length === 0 && query.trim() !== '') {
    // The filter only sees what has been opened, so an empty result is as much
    // about which folders are expanded as about the query.
    filesContent.appendChild(note('Nothing loaded matches. Open a folder to search deeper.'));
  }
}

function rowElement(row: FileRow): HTMLElement {
  if (row.kind === 'entry') return entryRow(row.node, row.depth, row.open, row.match);
  if (row.kind === 'loading') return skeletonRow(row.depth);
  if (row.kind === 'unreadable') {
    return messageRow(row.depth, row.path === ''
      ? 'This project folder could not be read'
      : 'This folder could not be read');
  }
  // The one kind left: a directory that was read and had nothing in it.
  return messageRow(row.depth, row.path === '' ? 'Nothing to show in this project' : 'Empty');
}

function entryRow(node: FileNode, depth: number, open: boolean, match?: MatchRange): HTMLElement {
  drawnNodes.set(node.path, node);

  const rowEl = indented(depth);
  rowEl.className = 'file-row';
  rowEl.dataset.path = node.path;
  rowEl.title = node.path;
  if (node.path === selectedPath) rowEl.classList.add('active');
  if (node.isSymbolicLink) rowEl.classList.add('symlink');

  const gutter = document.createElement('span');
  gutter.className = 'file-gutter';

  const chevron = document.createElement('span');
  chevron.className = 'file-chevron';
  // A leaf keeps the empty chevron box, so every name in a level starts on the
  // same column whether its neighbours are folders or files.
  if (canExpand(node)) chevron.innerHTML = open ? ICONS.chevronDown(10) : ICONS.chevronRight(10);
  gutter.appendChild(chevron);

  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.innerHTML = node.isDirectory ? ICONS.folder(14) : LEAF_ICON;
  gutter.appendChild(icon);
  rowEl.appendChild(gutter);

  rowEl.appendChild(nameElement(node, match));

  const failed = readErrors.get(node.path);
  if (failed !== undefined) {
    const error = document.createElement('span');
    error.className = 'file-row-error';
    error.textContent = failed;
    error.title = failed;
    rowEl.appendChild(error);
  }
  return rowEl;
}

/** The name, with the matched run of a search picked out of it. */
function nameElement(node: FileNode, match?: MatchRange): HTMLElement {
  const nameEl = document.createElement('span');
  nameEl.className = 'file-name';

  const hit = nameHighlight(node, match);
  if (hit === null) {
    nameEl.textContent = node.name;
    return nameEl;
  }

  nameEl.appendChild(document.createTextNode(node.name.slice(0, hit.start)));
  const mark = document.createElement('span');
  mark.className = 'file-match';
  mark.textContent = node.name.slice(hit.start, hit.end);
  nameEl.appendChild(mark);
  nameEl.appendChild(document.createTextNode(node.name.slice(hit.end)));
  return nameEl;
}

function skeletonRow(depth: number): HTMLElement {
  const rowEl = indented(depth);
  rowEl.className = 'file-row file-row-skeleton';
  const bar = document.createElement('span');
  bar.className = 'file-skeleton-bar';
  rowEl.appendChild(bar);
  return rowEl;
}

function messageRow(depth: number, text: string): HTMLElement {
  const rowEl = indented(depth);
  rowEl.className = 'file-row file-row-note';
  rowEl.textContent = text;
  return rowEl;
}

/**
 * A row at its nesting level.
 *
 * The depth is handed to the stylesheet as a number rather than being turned
 * into a padding here, so how far a level is indented stays one value, written
 * once in `_files.scss`, instead of a px constant in the JavaScript that has to
 * be kept equal to it.
 */
function indented(depth: number): HTMLElement {
  const rowEl = document.createElement('div');
  rowEl.style.setProperty('--file-depth', String(depth));
  return rowEl;
}

/** A line of prose where the tree would be: no scope, or nothing matched. */
function note(text: string): HTMLElement {
  const noteEl = document.createElement('div');
  noteEl.className = 'files-empty';
  noteEl.textContent = text;
  return noteEl;
}
