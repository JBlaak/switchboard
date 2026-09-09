/**
 * The Changes list: what changed in the scoped worktree, grouped by the session
 * that changed it.
 *
 * It sits above the file tree inside `#files-content`, and the two are
 * deliberately independent — the tree reads directories, this reads git and the
 * transcripts, and neither redraw touches the other's container. What they do
 * share is the tab: both are drawn when the Files tab comes up, and both are
 * dropped when the scope moves.
 *
 * The drawing and the IPC only. Every decision about what the list contains,
 * which group a file lands in, what order the groups come in and what a query
 * leaves standing is in `changes-list-model.ts`, which has no DOM in it and is
 * tested directly.
 *
 * Three things about this module are load-bearing.
 *
 * **One round trip.** `window.api.getChanges` composes git and attribution in
 * the main process; asking for the two halves separately would let them
 * disagree on screen. It is also the expensive call on this surface — a diff of
 * the whole tree plus a walk of the project's transcripts — so it is made when
 * the tab is shown or the scope moves, and not on a timer.
 *
 * **The base shown is the base used.** Git falls back to uncommitted-only when
 * the requested ref cannot be resolved (invariant 7), and the header says so
 * where it happens. A silently different base is a lie about what you are
 * looking at.
 *
 * **The skeleton is built once.** The header, the tools row and the group list
 * are permanent children of the section and only their contents are replaced,
 * because rebuilding the filter field under the cursor would drop focus on
 * every keystroke.
 *
 * Where a clicked file is *shown* is not this module's business: `files-tab.ts`
 * passes that in, for the same reason it does for the tree — the code area
 * imports the tab router, which imports the search, which drives the tree.
 */
import { baseLabel, buildChangesView, shortSessionId, statusTone } from './changes-list-model';
import { cleanDisplayName } from '../../../domain/session/title';
import { filesContent } from '../../lib/dom';
import { getScope } from '../../state/scope-store';
import { sessionMap, view } from '../../state/session-store';
import type { ChangeGroup, ChangeRow, ChangesView } from './changes-list-model';
import type { ChangesPayload } from '../../../domain/changes/types';
import type { DiffBase } from '../../../domain/git/types';
import type { OpenedFile } from './file-tree';

/**
 * The base the list asks for.
 *
 * Open question 2 has not been answered — the default is meant to be the
 * repository's own default branch, chosen through a picker that does not exist
 * yet — and merge-base is the useful reading for a worktree: *what has this
 * branch done*, rather than every commit `main` has made since it was cut. A
 * repository with no `main` is not lied to: git resolves what it can, falls
 * back to uncommitted-only and reports both, and the header prints the
 * fallback. That is invariant 7 working, not a failure mode.
 */
const REQUESTED_BASE: DiffBase = { kind: 'merge-base', ref: 'main' };

/** The whole surface, or null before `installChangesList`. */
let section: HTMLElement | null = null;
let headerEl: HTMLElement | null = null;
let noteEl: HTMLElement | null = null;
let toolsEl: HTMLElement | null = null;
let filterEl: HTMLInputElement | null = null;
let generatedEl: HTMLInputElement | null = null;
let groupsEl: HTMLElement | null = null;

/** The worktree the list is showing, so a scope change can be recognised. */
let shownRoot: string | null = null;

/** The last answer, its error, and whether one is in flight. */
let payload: ChangesPayload | null = null;
let failure: string | null = null;
let loading = false;

/**
 * Which request is the current one.
 *
 * Two scope changes in a row leave two answers in flight, and the slower one
 * must not overwrite the newer list.
 */
let generation = 0;

/** The filter, held here rather than in the field so a redraw keeps it. */
let query = '';
let showGenerated = true;

/** The row the user last opened, so the list says where they are. */
let selectedPath: string | null = null;

/** path → why the last attempt to open it failed, printed on its row. */
const readErrors = new Map<string, string>();

/** Where a clicked file is shown; supplied by `files-tab.ts`. */
let showFile: (file: OpenedFile) => void = () => {};

/** Build the section and wire its handlers up. Does not fetch: the tab does that. */
export function installChangesList(onOpenFile: (file: OpenedFile) => void): void {
  if (section) return;
  showFile = onOpenFile;

  section = document.createElement('div');
  section.id = 'changes-section';
  section.hidden = true;

  headerEl = document.createElement('div');
  headerEl.className = 'changes-header';
  section.appendChild(headerEl);

  noteEl = document.createElement('div');
  noteEl.className = 'changes-note';
  noteEl.hidden = true;
  section.appendChild(noteEl);

  section.appendChild(buildTools());

  groupsEl = document.createElement('div');
  groupsEl.className = 'changes-groups';
  groupsEl.addEventListener('click', event => {
    const rowEl = (event.target as HTMLElement | null)?.closest<HTMLElement>('.change-row');
    const path = rowEl?.dataset.path;
    if (path !== undefined) void open(path);
  });
  section.appendChild(groupsEl);

  // First child of the tab: the changes come above the tree, whichever of the
  // two installed first.
  filesContent.prepend(section);

  // What a later scope change is compared against. Nothing is fetched here —
  // reading a diff for a tab nobody has opened is the cost this surface most
  // has to avoid.
  shownRoot = scopeRoot();
}

/**
 * Draw the list for whatever is in scope, fetching if the scope has moved.
 *
 * Called every time the tab comes up rather than once: the scope may have
 * changed while another tab was showing, and a session may have written a file
 * since the last look. Refetching on every show is the refresh gesture this
 * surface has — the alternative is a poll, and a diff of the whole tree plus a
 * walk of the transcripts is not something to do on a timer nobody asked for.
 */
export function showChangesList(): void {
  const root = scopeRoot();
  if (root !== shownRoot) forget();
  if (root === null) {
    draw();
    return;
  }
  void refresh();
}

/**
 * Forget the list; the scope it was showing is no longer the one in effect.
 *
 * A scope change that lands on the same directory is not one — `scope-store`
 * also notifies when the scoped project's *worktrees* change — so the root is
 * compared before anything is thrown away, exactly as the tree does.
 */
export function resetChangesList(): void {
  if (scopeRoot() === shownRoot) return;
  onScopeMoved();
}

function onScopeMoved(): void {
  forget();
  if (view.activeTab === 'files') showChangesList();
  else draw();
}

function forget(): void {
  payload = null;
  failure = null;
  loading = false;
  query = '';
  showGenerated = true;
  selectedPath = null;
  readErrors.clear();
  shownRoot = scopeRoot();
  if (filterEl) filterEl.value = '';
  if (generatedEl) generatedEl.checked = true;
}

/**
 * The directory the list asks about: the scoped worktree, or the project itself
 * when the scope names no checkout. Null is "All", which is no place — and the
 * section is then absent rather than empty, because "changes" has no meaning
 * across every project at once.
 */
function scopeRoot(): string | null {
  const scope = getScope();
  return scope === null ? null : scope.worktreePath ?? scope.projectPath;
}

/** One round trip: what git says changed, and who the transcripts say changed it. */
async function refresh(): Promise<void> {
  const scope = getScope();
  if (scope === null) return;
  const root = scope.worktreePath ?? scope.projectPath;
  const mine = ++generation;

  loading = true;
  draw();

  const answer = await window.api.getChanges(root, scope.projectPath, REQUESTED_BASE);
  // The scope moved while this was in flight, or a newer request has already
  // been answered: this list describes a place the user has left.
  if (mine !== generation || scopeRoot() !== root) return;

  loading = false;
  // The `{ ok: false, error }` envelope every invoke can answer with — git
  // failing on the worktree, most likely because it is not a repository. Shown
  // where the list would be: an empty list would read as "nothing changed",
  // which is a different and untrue statement.
  if (!Array.isArray(answer?.files)) {
    payload = null;
    failure = errorOf(answer) ?? 'Changes could not be read';
  } else {
    payload = answer;
    failure = null;
  }
  draw();
}

function errorOf(answer: unknown): string | null {
  const error = (answer as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error !== '' ? error : null;
}

/**
 * Open a changed file in the code area.
 *
 * The file as it is now, not its diff: the whole-diff surface is a later
 * milestone. A file that is no longer there cannot be read at all, and saying
 * so on the row is better than an ENOENT with an absolute path in it.
 */
async function open(path: string): Promise<void> {
  const root = shownRoot;
  if (root === null) return;

  selectedPath = path;
  readErrors.delete(path);

  const row = rowFor(path);
  if (row?.status === 'D') {
    readErrors.set(path, 'Deleted — there is nothing left to open');
    draw();
    return;
  }
  draw();

  const result = await window.api.readProjectFile(root, path);
  if (shownRoot !== root) return;
  if (typeof result?.content === 'string') {
    showFile({ worktreePath: root, relPath: path, content: result.content });
    return;
  }
  readErrors.set(path, result?.error ?? 'Could not read this file');
  draw();
}

/** The row for a path, from the answer rather than from the DOM. */
function rowFor(path: string): { status: string } | undefined {
  return payload?.files.find(file => file.path === path)
    ?? payload?.untracked.find(file => file.path === path);
}

// ── drawing ───────────────────────────────────────────────────────────────────

function buildTools(): HTMLElement {
  toolsEl = document.createElement('div');
  toolsEl.className = 'changes-tools';
  toolsEl.hidden = true;

  filterEl = document.createElement('input');
  filterEl.type = 'text';
  filterEl.className = 'changes-filter';
  filterEl.placeholder = 'Filter changed files';
  filterEl.addEventListener('input', () => {
    query = filterEl?.value ?? '';
    // Only the groups: redrawing the field the user is typing in would take the
    // caret with it.
    drawGroups();
  });
  toolsEl.appendChild(filterEl);

  const toggle = document.createElement('label');
  toggle.className = 'changes-generated';
  generatedEl = document.createElement('input');
  generatedEl.type = 'checkbox';
  generatedEl.checked = true;
  generatedEl.addEventListener('change', () => {
    showGenerated = generatedEl?.checked !== false;
    drawGroups();
  });
  toggle.appendChild(generatedEl);
  toggle.appendChild(document.createTextNode('Generated'));
  toggle.title = 'Lockfiles and build output, as .gitattributes and the usual names have them';
  toolsEl.appendChild(toggle);

  return toolsEl;
}

function draw(): void {
  if (!section) return;

  if (shownRoot === null) {
    section.hidden = true;
    filesContent.classList.remove('changes-crowded');
    return;
  }
  section.hidden = false;
  drawHeader();
  drawGroups();
}

function drawHeader(): void {
  const host = headerEl;
  if (!host || !noteEl) return;
  host.textContent = '';

  const title = document.createElement('span');
  title.className = 'changes-title';
  title.textContent = 'Changes';
  host.appendChild(title);

  const current = viewNow();
  if (current) {
    const base = document.createElement('span');
    base.className = 'changes-base';
    base.textContent = current.base.kind === 'uncommitted'
      ? 'uncommitted'
      : `vs ⎇ ${baseLabel(current.base)}`;
    base.title = current.base.kind === 'uncommitted'
      ? 'Everything not yet committed'
      : `Compared against ${baseLabel(current.base)}`;
    host.appendChild(base);

    host.appendChild(diffstat(current.totals.additions, current.totals.deletions, 'changes-stat'));

    // Invariant 7: git could not use what was asked for, so say which base this
    // list is really about instead of letting the header imply the other one.
    noteEl.hidden = !current.baseMismatch;
    noteEl.textContent = current.baseMismatch
      ? `${baseLabel(current.requestedBase)} could not be resolved here — showing ${baseLabel(current.base)}`
      : '';
  } else {
    noteEl.hidden = true;
  }
}

function drawGroups(): void {
  const host = groupsEl;
  if (!host) return;
  host.textContent = '';

  const current = failure === null ? viewNow() : null;
  // The filter field and the height the tree gives up are both properties of a
  // list that exists: an error, or an answer that has not arrived, takes them
  // both back rather than leaving a box that narrows nothing.
  const crowded = current?.crowded === true;
  setCrowded(crowded);
  if (toolsEl) toolsEl.hidden = !crowded;

  if (failure !== null) {
    host.appendChild(note(failure, 'changes-error'));
    return;
  }
  if (!current) {
    // Before the first answer there is nothing true to say: "nothing changed"
    // would be a claim about a worktree that has not been read yet.
    if (loading) host.appendChild(note('Reading what changed…'));
    return;
  }

  if (current.groups.length === 0) {
    host.appendChild(note(current.totals.files === 0
      ? 'Nothing has changed yet'
      : `All ${current.hidden} changed files are filtered out`));
    return;
  }

  for (const group of current.groups) host.appendChild(groupElement(group));

  if (current.hidden > 0) {
    host.appendChild(note(`${current.hidden} more hidden by the filter`));
  }
}

/** The view for what is on screen right now, or null before the first answer. */
function viewNow(): ChangesView | null {
  return payload === null ? null : buildChangesView(payload, { query, showGenerated });
}

/**
 * Whether the tree below has to give up height.
 *
 * A class on the tab rather than a style on the tree: the two sections are
 * independent modules, and how much room each gets is one decision written once
 * in `_files.scss`.
 */
function setCrowded(crowded: boolean): void {
  filesContent.classList.toggle('changes-crowded', crowded);
}

function groupElement(group: ChangeGroup): HTMLElement {
  const groupEl = document.createElement('div');
  groupEl.className = 'changes-group';

  const header = document.createElement('div');
  header.className = 'changes-group-header';

  if (group.kind === 'session') {
    const dot = document.createElement('span');
    // The same dot the session list draws, in the same two states, so the two
    // surfaces cannot disagree about who is running.
    dot.className = 'session-status-dot'
      + (view.activePtyIds.has(group.sessionId ?? '') ? ' running' : '');
    header.appendChild(dot);
  }

  const name = document.createElement('span');
  name.className = 'changes-group-name';
  name.textContent = group.kind === 'session'
    ? sessionLabel(group.sessionId ?? '')
    : 'Generated · not by a session';
  name.title = group.kind === 'session'
    ? group.sessionId ?? ''
    : 'Changed files no transcript claims';
  header.appendChild(name);

  const count = document.createElement('span');
  count.className = 'changes-group-count';
  count.textContent = String(group.rows.length);
  header.appendChild(count);

  groupEl.appendChild(header);
  for (const row of group.rows) groupEl.appendChild(rowElement(row));
  return groupEl;
}

/**
 * What a session is called here.
 *
 * The same three sources the sidebar's row uses, resolved locally rather than
 * imported from it: that module reaches the session panel and the sidebar's own
 * state, none of which this surface needs. A session the renderer has never
 * heard of — one whose transcript is older than the cache, or that has been
 * removed — still gets an identity, because a group with no heading would be
 * worse than a short id.
 */
function sessionLabel(sessionId: string): string {
  const session = sessionMap.get(sessionId);
  const name = session
    ? cleanDisplayName(session.name || session.aiTitle || session.summary)
    : null;
  return name || shortSessionId(sessionId);
}

function rowElement(row: ChangeRow): HTMLElement {
  const rowEl = document.createElement('div');
  rowEl.className = 'change-row';
  rowEl.dataset.path = row.path;
  rowEl.title = row.oldPath ? `${row.oldPath} → ${row.path}` : row.path;
  if (row.path === selectedPath) rowEl.classList.add('active');
  if (row.generated) rowEl.classList.add('is-generated');

  const status = document.createElement('span');
  status.className = `change-status is-${statusTone(row.status)}`;
  status.textContent = row.status;
  rowEl.appendChild(status);

  rowEl.appendChild(pathElement(row.path));

  if (row.status === 'U') rowEl.appendChild(marker('conflict', 'change-conflict'));
  // A file two sessions have both written is the state this surface exists to
  // show, and the one worth a second look before either half is trusted.
  if (row.shared) rowEl.appendChild(marker('2+', 'change-shared'));

  const failed = readErrors.get(row.path);
  if (failed !== undefined) {
    const error = document.createElement('span');
    error.className = 'change-row-error';
    error.textContent = failed;
    error.title = failed;
    rowEl.appendChild(error);
    return rowEl;
  }

  if (row.binary) rowEl.appendChild(marker('binary', 'change-note-tag'));
  else if (row.submodule) rowEl.appendChild(marker('submodule', 'change-note-tag'));
  else if (!row.untracked) rowEl.appendChild(diffstat(row.additions, row.deletions, 'change-stat'));

  return rowEl;
}

/**
 * `src/renderer/` and `app.ts`, as two elements.
 *
 * The directories go in the box that shrinks and the file name in the one that
 * does not, so a path too long for the sidebar loses its leading folders rather
 * than the segment that identifies it — the same split the code area's
 * breadcrumb makes.
 */
function pathElement(path: string): HTMLElement {
  const host = document.createElement('span');
  host.className = 'change-path';

  const cut = path.lastIndexOf('/');
  if (cut >= 0) {
    const dirs = document.createElement('span');
    dirs.className = 'change-dir';
    dirs.textContent = path.slice(0, cut + 1);
    host.appendChild(dirs);
  }

  const name = document.createElement('span');
  name.className = 'change-name';
  name.textContent = path.slice(cut + 1);
  host.appendChild(name);
  return host;
}

function marker(text: string, className: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  if (className === 'change-shared') el.title = 'More than one session claims this file';
  return el;
}

/** `+n −m`, with a side that contributed nothing left out rather than zeroed. */
function diffstat(additions: number, deletions: number, className: string): HTMLElement {
  const stat = document.createElement('span');
  stat.className = className;

  if (additions > 0) {
    const add = document.createElement('span');
    add.className = 'change-add';
    add.textContent = `+${additions}`;
    stat.appendChild(add);
  }
  if (deletions > 0) {
    const del = document.createElement('span');
    del.className = 'change-del';
    del.textContent = `−${deletions}`;
    stat.appendChild(del);
  }
  return stat;
}

/** A line of prose where the list would be. */
function note(text: string, className = 'changes-empty'): HTMLElement {
  const noteRow = document.createElement('div');
  noteRow.className = className;
  noteRow.textContent = text;
  return noteRow;
}
