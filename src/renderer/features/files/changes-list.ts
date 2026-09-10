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
import {
  BASE_CHOICE_SETTING, DEFAULT_BASE_CHOICE, baseForChoice, baseLabel, baseOptions,
  buildChangesView, parseBaseChoice, shortSessionId, statusTone,
} from './changes-list-model';
import { cleanDisplayName } from '../../../domain/session/title';
import { projectSettingsKey } from '../../../domain/settings/settings';
import { filesContent } from '../../lib/dom';
import { getScope } from '../../state/scope-store';
import { sessionMap, view } from '../../state/session-store';
import type { BaseChoice, ChangeGroup, ChangeRow, ChangesView } from './changes-list-model';
import type { ChangesPayload } from '../../../domain/changes/types';
import type { OpenedFile } from './file-tree';

/**
 * What the list is compared against — open question 2, closed.
 *
 * The base used to be the constant `{ kind: 'merge-base', ref: 'main' }`, which
 * is right for most repositories and quietly wrong for every one that kept
 * `master`: the ref does not resolve, git falls back to uncommitted-only and
 * says so — invariant 7 working — and the user is still looking at a diff they
 * did not ask for. So the branch is detected (`gitDefaultBranch`) rather than
 * assumed, and which of the three readings to take is the user's, remembered
 * per project.
 *
 * Both are memoised here rather than re-read per refresh: the branch cannot
 * change under a worktree while the app is open, and the choice is only changed
 * through `chooseBase`, which is the thing that writes it.
 */
const branchByRoot = new Map<string, string | null>();
const choiceByProject = new Map<string, BaseChoice>();

/** The choice and the branch in effect for what is on screen. */
let choice: BaseChoice = DEFAULT_BASE_CHOICE;
let defaultBranch: string | null = null;

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

/**
 * Where `View all changes` goes; supplied by `files-tab.ts` for the same reason
 * `showFile` is — the whole-diff surface lives in the code area, which imports
 * the tab router, which imports the search, which drives this tab's neighbour.
 * The seam is what keeps that from being a cycle.
 */
let showDiff: (focusPath?: string) => void = () => {};

/** Build the section and wire its handlers up. Does not fetch: the tab does that. */
export function installChangesList(
  onOpenFile: (file: OpenedFile) => void,
  onOpenDiff: (focusPath?: string) => void,
): void {
  if (section) return;
  showFile = onOpenFile;
  showDiff = onOpenDiff;

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
  choice = DEFAULT_BASE_CHOICE;
  defaultBranch = null;
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

  // What to compare against, before anything can be asked for: the branch this
  // repository calls its default, and the reading of it this project chose. Two
  // round trips on the first look at a project, none after that.
  const [branch, chosen] = await Promise.all([
    defaultBranchFor(root), choiceFor(scope.projectPath),
  ]);
  if (mine !== generation || scopeRoot() !== root) return;
  defaultBranch = branch;
  choice = chosen;

  const answer = await window.api.getChanges(
    root, scope.projectPath, baseForChoice(chosen, branch));
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

/**
 * What this repository calls its default branch, asked once per worktree.
 *
 * A failure — the `{ ok: false, error }` envelope, or a folder that is not a
 * repository — is null, which is a worktree with nothing to compare against and
 * leaves uncommitted-only as the only honest reading. Remembered either way, so
 * a repository without one is not asked again on every scope change.
 */
async function defaultBranchFor(root: string): Promise<string | null> {
  const known = branchByRoot.get(root);
  if (known !== undefined) return known;

  const answer = await window.api.gitDefaultBranch(root);
  const branch = typeof answer === 'string' && answer !== '' ? answer : null;
  branchByRoot.set(root, branch);
  return branch;
}

/** The project's remembered choice, or the default for one that has never chosen. */
async function choiceFor(projectPath: string): Promise<BaseChoice> {
  const known = choiceByProject.get(projectPath);
  if (known !== undefined) return known;

  const stored = await window.api.getSetting<Record<string, unknown>>(
    projectSettingsKey(projectPath));
  const chosen = parseBaseChoice(stored?.[BASE_CHOICE_SETTING]) ?? DEFAULT_BASE_CHOICE;
  choiceByProject.set(projectPath, chosen);
  return chosen;
}

/**
 * Compare against something else, and remember it for the project.
 *
 * Per project rather than per worktree: the reading someone wants — *what has
 * this branch done* against *everything not committed* — is a habit they have
 * about a repository, and every checkout of it is the same kind of place. The
 * write is read-modify-write over the project's settings blob, the way the
 * settings panel writes into the same one.
 *
 * Exported because the diff surface draws the same control over the same
 * answer; changing it there has to change it here, or the two headers would
 * disagree about what they are showing.
 */
export function chooseBase(next: BaseChoice): void {
  const scope = getScope();
  if (scope === null || next === choice) return;

  choice = next;
  choiceByProject.set(scope.projectPath, next);
  void remember(scope.projectPath, next);
  void refresh();
}

/** The base the list is asking for, for a surface drawing the same control. */
export function currentBaseChoice(): BaseChoice {
  return choice;
}

/** The branch that choice names here, or null where none resolved. */
export function currentDefaultBranch(): string | null {
  return defaultBranch;
}

async function remember(projectPath: string, next: BaseChoice): Promise<void> {
  const key = projectSettingsKey(projectPath);
  const stored = (await window.api.getSetting<Record<string, unknown>>(key)) || {};
  await window.api.setSetting(key, { ...stored, [BASE_CHOICE_SETTING]: next });
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

// ── what the folded code strip reads ──────────────────────────────────────────
//
// The strip along the bottom of the conversation says the same three things
// this list's header says — how many files, the diffstat, the base — and offers
// a chip per changed file. It is the same answer, so it is the same fetch:
// `getChanges` is a diff of the whole tree plus a walk of the project's
// transcripts, and a second caller making the same round trip would both cost
// twice and let the two surfaces disagree about what changed. These five
// exports are the seam.

type ChangesWatcher = () => void;
const watchers = new Set<ChangesWatcher>();

/** Be told whenever the answer, or the lack of one, has moved. */
export function onChangesChanged(fn: ChangesWatcher): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

/**
 * One that throws is logged and skipped, exactly as the scope store does: a
 * strip that fails to draw must not stop the list itself from redrawing.
 */
function notifyWatchers(): void {
  for (const watcher of [...watchers]) {
    try {
      watcher();
    } catch (err) {
      console.error('changes watcher failed', err);
    }
  }
}

/**
 * The whole answer, unfiltered — what the strip summarises.
 *
 * Unfiltered because the sidebar's query and its `Generated` toggle narrow the
 * *list*, and a strip that quietly counted fewer files than the tree does would
 * be a second, disagreeing account of the same worktree. Null while there is no
 * answer: before the first fetch, after a scope change, or when the read failed.
 */
export function currentChangesView(): ChangesView | null {
  return payload === null ? null : buildChangesView(payload);
}

/**
 * The raw answer, for the surface that needs more of it than a row.
 *
 * The whole-worktree diff reads every field `getChanges` carries — `truncated`,
 * `noNewlineAtEof`, `modeChange`, the similarity of a rename — none of which a
 * sidebar row has any use for, so `ChangesView` deliberately drops them. Rather
 * than widen that shape for a second reader, the second reader gets the answer
 * itself. Still one round trip: this is the same object the list is drawn from.
 */
export function currentChangesPayload(): ChangesPayload | null {
  return payload;
}

/** The worktree the current answer describes, or null when nothing is scoped. */
export function changesRoot(): string | null {
  return shownRoot;
}

/**
 * Open the whole worktree's diff, optionally scrolled to one file.
 *
 * The Changes list's header and the folded strip's chips both come through
 * here rather than importing the code area, for the reason `showDiff` gives.
 */
export function openWholeDiff(focusPath?: string): void {
  showDiff(focusPath);
}

/** Why the last read failed, for a strip that would otherwise say "nothing". */
export function changesFailure(): string | null {
  return failure;
}

/**
 * Fetch what changed, unless it is already known or already in flight.
 *
 * `showChangesList` is the tab's gesture and refetches every time the tab comes
 * up, which is the refresh the user is asking for by opening it. The strip is on
 * screen continuously, so it asks only for what it does not have — otherwise
 * every redraw would start a diff of the whole tree.
 */
export function ensureChangesLoaded(): void {
  const root = scopeRoot();
  if (root !== shownRoot) forget();
  if (root === null) {
    draw();
    return;
  }
  if (loading || payload !== null || failure !== null) return;
  void refresh();
}

/**
 * Open a changed file the same way a click on its row does.
 *
 * Kept for the callers that want the file rather than the diff of it — the
 * folded strip's chips used to be one and are now the other, so nothing in the
 * renderer calls this at the moment. It stays because it is the other half of
 * the seam `openWholeDiff` is one half of, and the pair is what the surfaces
 * outside this module are allowed to ask for.
 */
export function openChangedFile(path: string): void {
  void open(path);
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
  if (section) {
    if (shownRoot === null) {
      section.hidden = true;
      filesContent.classList.remove('changes-crowded');
    } else {
      section.hidden = false;
      drawHeader();
      drawGroups();
    }
  }
  // Outside the guard: the folded code strip reads the same answer and is on
  // screen whether or not this section has been built.
  notifyWatchers();
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
    drawBase(current, host);

    host.appendChild(diffstat(current.totals.additions, current.totals.deletions, 'changes-stat'));

    // Invariant 6: the code side opens on the *whole* diff, and a list of files
    // that only ever opens them one at a time would quietly make the sidebar
    // the way you read a change. This is the door to the other reading, and it
    // is next to the numbers it is the long form of.
    if (current.totals.files > 0) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'changes-all-btn';
      all.textContent = 'Diff';
      all.title = 'View all changes in one scroll';
      all.addEventListener('click', () => openWholeDiff());
      host.appendChild(all);
    }

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

/**
 * The base control, and — when git could not use what it asked for — the base
 * that is really on screen.
 *
 * The select carries the *request*: it is the thing the user changes and the
 * thing remembered for the project. The base actually used is what invariant 7
 * is about, and when the two agree the select's own label already is it, so a
 * second copy would be furniture. When they differ, the used base is printed
 * beside the control as it always was, and the note under the header spells out
 * why.
 *
 * A repository with no default branch has one honest reading and so no picker:
 * it gets the plain label, which is what this header drew before there was a
 * control at all.
 */
function drawBase(current: ChangesView, host: HTMLElement): void {
  const options = baseOptions(defaultBranch);

  if (options.length > 1) {
    const pick = document.createElement('select');
    pick.className = 'changes-base-pick';
    pick.title = 'What this list is compared against';
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option.choice;
      item.textContent = option.choice === 'uncommitted' ? option.label : `vs ⎇ ${option.label}`;
      item.title = option.title;
      if (option.choice === choice) item.selected = true;
      pick.appendChild(item);
    }
    pick.addEventListener('change', () => {
      const next = parseBaseChoice(pick.value);
      if (next !== null) chooseBase(next);
    });
    host.appendChild(pick);
    if (!current.baseMismatch) return;
  }

  const base = document.createElement('span');
  base.className = 'changes-base';
  base.textContent = current.base.kind === 'uncommitted'
    ? 'uncommitted'
    : `vs ⎇ ${baseLabel(current.base)}`;
  base.title = current.base.kind === 'uncommitted'
    ? 'Everything not yet committed'
    : `Compared against ${baseLabel(current.base)}`;
  host.appendChild(base);
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
