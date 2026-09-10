/**
 * The whole worktree's diff, in one scroll.
 *
 * Invariant 6: the code side opens on the whole diff, not one file at a time —
 * every changed file of the scoped worktree against its base, sticky headers
 * naming each one, and scrolling from the top means having read the change.
 * `Diff / File` is a second flip *within* this half for reading one file whole,
 * and that half lives in `code-area.ts` because it is the code area's own
 * breadcrumb bar it draws into.
 *
 * Five things here are load-bearing.
 *
 * **No `EditorView`, ever.** Invariant 8. A 212-file diff cannot be 212
 * CodeMirror instances, so every line on this surface is plain DOM coloured by
 * `lib/highlight-static.ts`. The live editor belongs to the file you open and
 * to the proposal review, and to nothing on this scroll.
 *
 * **Two phases, and the second one is bought a file at a time.**
 * `getChanges` classifies the whole tree with one git command and carries no
 * lines at all; `gitDiffFile` buys the lines of one file. So the first paint is
 * 212 headers — which is fast, and is the number this milestone is measured on
 * — and a patch is fetched only when its section comes near the viewport. A
 * regenerated lockfile is known to be 12,000 lines without anybody reading
 * them across IPC.
 *
 * **The scroll is not rebuilt to fill it.** Sections are built once as empty
 * boxes with `content-visibility: auto` and an intrinsic size guessed from the
 * diffstat; an intersection observer fills the ones that come close. Rebuilding
 * the list would move the scroll under the reader, so the only things that
 * rebuild it are the header's own toggles and a fresh answer from git.
 *
 * **Nothing is a silent difference.** A rename is one line rather than a delete
 * and an add; a mode change and a missing final newline each get a note; a
 * generated file is hidden but counted; an oversize one is folded but
 * expandable; a whitespace-only one is tagged and sorted last. Every one of
 * those is on by default and every one is reversible from the header, because
 * a default you cannot turn off is a missing file rather than a tidy one.
 *
 * **One round trip, shared.** The answer comes from `changes-list.ts`, which is
 * the module that owns the `getChanges` call the sidebar and the folded strip
 * already share. A second fetch here would both cost twice and let two
 * surfaces disagree about what changed.
 *
 * And four of them are not a hunk you can read at all — a merge conflict, a
 * file two sessions both wrote, a file that changed while you were reading it,
 * and a minified line nothing can colour. The first three are drawn below;
 * every decision in them (which rows are markers, who can be asked, what is
 * stale, what is affordable to colour) is in the model, so what is here is
 * elements and a click handler.
 *
 * The rules — what a section is, which body it draws, what order they come in,
 * what the counts add up to, and which sections are worth building right now —
 * are in `diff-view-model.ts`, which has no DOM in it and is tested directly.
 */
import {
  DEFAULT_OVERSCAN, askTarget, attributionOf, buildDiffView, colourable, conflictPrompt,
  conflictRegionsIn, conflictRoles, estimatedHeight, markStale, nextWatched, visibleSections,
} from './diff-view-model';
import { baseLabel } from '../files/changes-list-model';
import { changesFailure, changesRoot, currentChangesPayload, ensureChangesLoaded, onChangesChanged } from '../files/changes-list';
import { cleanDisplayName } from '../../../domain/session/title';
import { formatDate, shortcutLabel } from '../../lib/format';
import { highlightLanguageFor, highlightLines, loadHighlightLanguage } from '../../lib/highlight-static';
import { isRemoteProjectPath } from '../../../domain/project/remote-target';
import { openSessions, sessionMap, view as sessionView } from '../../state/session-store';
import { shortSessionId } from '../files/changes-list-model';
import { showSession } from '../terminal/terminal-manager';
import type { ConflictRole, DiffSection, DiffView } from './diff-view-model';
import type { FileDiff, Hunk, HunkLine } from '../../../domain/git/types';
import type { MainMode } from '../../app/main-mode-model';
import { openFilesTab } from '../../app/tab-router';
import { getScope } from '../../state/scope-store';
import { projectSettingsKey } from '../../../domain/settings/settings';

/**
 * Where the surface draws: a strip that shares the code area's header bar, and
 * the scroll below it. Two mounts rather than one for the reason the review
 * has two — `code-area.ts` owns which of the header's occupants is up.
 */
export interface DiffViewMounts {
  header: HTMLElement;
  body: HTMLElement;
}

/** A file the reader asked to see whole, with the diff's context carried over. */
export interface WholeFileRequest {
  worktreePath: string;
  relPath: string;
  /**
   * Lines of the *new* side this diff added or changed, 1-based.
   *
   * The green gutter bars in the whole-file view. Without them the diff simply
   * vanishes the moment you read around it, which is the thing `Diff / File` is
   * supposed to avoid.
   */
  changedLines: readonly number[];
  /** Present instead of the file on disk for a deletion: the text at the base. */
  contentAtBase?: string;
}

/** What the surface cannot do for itself. */
export interface DiffViewHandlers {
  /** Show one file whole, in place of this scroll. */
  onOpenFile(request: WholeFileRequest): void;
  /** The flip's setter, so `Talk | Split | Code` works from this header too. */
  onPickMode(mode: MainMode): void;
}

/** How many patches to have in flight at once. */
const FETCH_LIMIT = 4;

/**
 * How far outside the viewport a section is still worth building.
 *
 * Two screens rather than the model's default one: the observer is what
 * actually triggers a *fetch*, and a patch takes a git process, so starting it
 * a screen earlier than the paint needs it is the difference between a section
 * that is already there and one that fills in under the reader.
 */
const OBSERVER_MARGIN = '150% 0px';

const STATUS_WORD: Record<string, string> = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied',
  U: 'conflicted', '?': 'untracked',
};

let mounts: DiffViewMounts | null = null;
let handlers: DiffViewHandlers | null = null;

// Header parts, built once so a redraw replaces text rather than nodes.
let worktreeEl: HTMLElement;
let baseEl: HTMLElement;
let countsEl: HTMLElement;
let noteEl: HTMLElement;
let generatedBtn: HTMLButtonElement;
let whitespaceBtn: HTMLButtonElement;
let wrapBtn: HTMLButtonElement;
let layoutButtons: Map<DiffLayout, HTMLButtonElement>;
let modeButtons: Map<MainMode, HTMLButtonElement>;

// Body parts.
let bannerEl: HTMLElement;
let scrollEl: HTMLElement;
let emptyEl: HTMLElement;

type DiffLayout = 'unified' | 'side-by-side';

/** Side-by-side or inline, under the key the review surface already uses. */
const LAYOUT_KEY = 'diffViewLayout';
const WRAP_KEY = 'diffViewWrap';

let layout: DiffLayout = localStorage.getItem(LAYOUT_KEY) === 'side-by-side'
  ? 'side-by-side' : 'unified';
let wrap = localStorage.getItem(WRAP_KEY) === 'on';
let hideGenerated = true;

/**
 * Fold reformats away, remembered per project.
 *
 * A project setting rather than a `localStorage` key, because whether a
 * reformat is noise is a fact about the repository, not about the reader: one
 * project runs a formatter on every save and one has never had one, and the
 * same person wants opposite answers in each. It sits in the same blob as the
 * base choice, written the same read-modify-write way.
 *
 * The default is on, and it stays on until the stored answer arrives — a
 * project that has never chosen reads back nothing, and the first paint should
 * not flash the whole reformat and then fold it.
 */
const IGNORE_WHITESPACE_SETTING = 'diffIgnoreWhitespace';
const whitespaceByProject = new Map<string, boolean>();
let ignoreWhitespace = true;

/** Paths the reader has expanded past a collapse. Survives a rebuild. */
const expanded = new Set<string>();

/** path → what `gitDiffFile` answered. Phase two, one file at a time. */
const loaded = new Map<string, FileDiff>();

/** Paths whose patch is in flight or queued, so nothing is fetched twice. */
const fetching = new Set<string>();
const queue: string[] = [];
let running = 0;

/** The view on screen, and the element built for each of its sections. */
let current: DiffView | null = null;
const elements = new Map<string, HTMLElement>();
let observer: IntersectionObserver | null = null;

/**
 * The files whose bodies are actually on the scroll, and the ones being watched.
 *
 * `drawn` is what a `fileChanged` event is matched against — a change to a file
 * nobody has scrolled to is not news — and `watched` is the bounded, ordered
 * subset the main process is holding an `fs.watch` open for.
 */
const drawn = new Set<string>();
let watched: string[] = [];

/** Paths a watcher says have changed since the reader last saw them. */
const stale = new Set<string>();

/** The worktree the scroll is describing, so a stale answer can be recognised. */
let shownRoot: string | null = null;

/** Set while this half is showing the diff, so a new answer redraws it. */
let live = false;

/** A path to scroll to once the sections exist. */
let pendingFocus: string | null = null;

// ── install ───────────────────────────────────────────────────────────────────

export function installDiffView(where: DiffViewMounts, who: DiffViewHandlers): void {
  if (mounts) return;
  mounts = where;
  handlers = who;

  buildHeader(where.header);
  buildBody(where.body);

  // The answer can arrive long after this half was opened — the sidebar's fetch
  // is the same one — and it changes every number and every section.
  onChangesChanged(() => { if (live) rebuild(); });

  // A session writing while the reader reads is the normal case, not the odd
  // one. The section is dimmed and offered a `Reload`; it is never re-rendered
  // underneath the reader, because that moves the scroll and loses the place.
  window.api.onFileChanged(onDiskChange);
}

/**
 * Put the whole diff on screen, optionally at one file.
 *
 * Called by `code-area.ts` once it has switched content to `diff`, so the
 * scroll is measurable by the time anything here reads a height.
 */
export function showDiffView(focusPath?: string): void {
  live = true;
  if (focusPath !== undefined) pendingFocus = focusPath;
  // Only asked for here: until this half is up, nobody is looking at the
  // answer, and a diff of the whole worktree is the expensive call.
  ensureChangesLoaded();
  void loadWhitespaceChoice();
  rebuild();
}

/**
 * Read this project's `Ignore whitespace` answer, and redraw if it differs.
 *
 * Asked each time the half opens rather than once, because the scope can
 * change while it is folded. The cache makes every visit after the first free,
 * and a project that has never chosen keeps the default without a write.
 */
async function loadWhitespaceChoice(): Promise<void> {
  const scope = getScope();
  if (scope === null) return;
  const { projectPath } = scope;

  let chosen = whitespaceByProject.get(projectPath);
  if (chosen === undefined) {
    const stored = await window.api.getSetting<Record<string, unknown>>(
      projectSettingsKey(projectPath));
    const value = stored?.[IGNORE_WHITESPACE_SETTING];
    chosen = typeof value === 'boolean' ? value : true;
    whitespaceByProject.set(projectPath, chosen);
  }

  if (chosen === ignoreWhitespace) return;
  ignoreWhitespace = chosen;
  if (live) rebuild();
}

/** Keep the toggle's new answer, for this project, across restarts. */
function rememberWhitespace(next: boolean): void {
  const scope = getScope();
  if (scope === null) return;
  const { projectPath } = scope;
  whitespaceByProject.set(projectPath, next);

  void (async () => {
    const key = projectSettingsKey(projectPath);
    const stored = (await window.api.getSetting<Record<string, unknown>>(key)) || {};
    await window.api.setSetting(key, { ...stored, [IGNORE_WHITESPACE_SETTING]: next });
  })();
}

/**
 * The scroll can be measured again: fill whatever is now on screen.
 *
 * A scroll built while this half was folded has a client height of zero, so it
 * decided one section was visible and stopped. `code-area.ts` calls this at the
 * end of every flip, which is the point at which the height is real — the same
 * reason the review rebuilds its merge view there.
 */
export function refreshDiffView(): void {
  if (!live || current === null) return;
  fillVisible();
  focusIfAsked();
}

/** The half has gone elsewhere: stop redrawing for answers nobody can see. */
export function hideDiffView(): void {
  live = false;
}

/**
 * Whether the whole diff has anything to say about this path.
 *
 * What `code-area.ts` asks before offering `Diff | File` on an open file: the
 * control only makes sense for a file that has two readings.
 */
export function diffHasPath(relPath: string): boolean {
  const payload = currentChangesPayload();
  if (payload === null) return false;
  return payload.files.some(file => file.path === relPath)
    || payload.untracked.some(file => file.path === relPath);
}

/**
 * The new-side lines this diff attributes to a change, fetching if it must.
 *
 * The green gutter bars of the whole-file view. Null when the path is not in
 * the diff, or when git could not answer for it — the file still opens, it just
 * opens without the bars rather than not at all.
 */
export async function changedLinesFor(relPath: string): Promise<number[] | null> {
  if (!diffHasPath(relPath)) return null;
  const file = loaded.get(relPath) ?? await fetchPatch(relPath);
  return file === null ? null : newSideLines(file.hunks);
}

// ── the header ────────────────────────────────────────────────────────────────

function buildHeader(host: HTMLElement): void {
  worktreeEl = pill('diff-head-worktree');
  baseEl = pill('diff-head-base');
  countsEl = span('diff-head-counts');
  noteEl = span('diff-head-note');
  noteEl.hidden = true;
  host.append(worktreeEl, baseEl, countsEl, noteEl);

  const controls = document.createElement('div');
  controls.className = 'diff-head-controls';

  generatedBtn = toggle('Hide generated',
    'Lockfiles and build output, as .gitattributes and the usual names have them',
    () => { hideGenerated = !hideGenerated; rebuild(); });
  whitespaceBtn = toggle('Ignore whitespace',
    'Fold files whose whole change is indentation, and sort them last. '
    + 'Not git diff -w: the counts stay the ones git reported.',
    () => {
      ignoreWhitespace = !ignoreWhitespace;
      rememberWhitespace(ignoreWhitespace);
      rebuild();
    });
  wrapBtn = toggle('Wrap',
    'Long lines never wrap by default — a wrapped 40,000-character line reads as a broken app',
    () => {
      wrap = !wrap;
      localStorage.setItem(WRAP_KEY, wrap ? 'on' : 'off');
      paintHeader();
      scrollEl.classList.toggle('is-wrapped', wrap);
    });
  controls.append(generatedBtn, whitespaceBtn, wrapBtn);

  layoutButtons = segmented(controls, 'How the two sides are laid out', [
    ['unified', 'Unified'], ['side-by-side', 'Side by side'],
  ], (value: DiffLayout) => {
    if (layout === value) return;
    layout = value;
    localStorage.setItem(LAYOUT_KEY, value);
    scrollEl.classList.toggle('is-split', layout === 'side-by-side');
    // Only the bodies change shape, but they change shape everywhere, so this
    // is the one gesture that legitimately rebuilds the scroll.
    rebuild();
  });

  // The same three-state control the terminal header carries, built here as
  // well because in `code` mode that header is not on screen — and a flip whose
  // only visible affordance is a shortcut is a flip nobody finds.
  modeButtons = segmented(controls, 'Which half owns the window', [
    ['talk', 'Talk'], ['split', 'Split'], ['code', 'Code'],
  ], (value: MainMode) => handlers?.onPickMode(value));

  const kbd = span('diff-head-kbd', shortcutLabel('J'));
  kbd.title = 'Swap the conversation and the code';
  controls.appendChild(kbd);

  host.appendChild(controls);
}

function buildBody(host: HTMLElement): void {
  bannerEl = document.createElement('div');
  bannerEl.className = 'diff-banner';
  bannerEl.hidden = true;
  host.appendChild(bannerEl);

  scrollEl = document.createElement('div');
  scrollEl.className = 'diff-scroll';
  scrollEl.classList.toggle('is-wrapped', wrap);
  scrollEl.classList.toggle('is-split', layout === 'side-by-side');
  scrollEl.addEventListener('click', onBodyClick);
  // The scroll is the only thing that can say which sections are near the
  // viewport, and the observer's own callback is not fired by a scroll that
  // does not cross a boundary — so the two together are what keep the fetch
  // queue ahead of the reader.
  scrollEl.addEventListener('scroll', () => scheduleFill(), { passive: true });
  host.appendChild(scrollEl);

  emptyEl = document.createElement('div');
  emptyEl.className = 'diff-empty';
  emptyEl.hidden = true;
  host.appendChild(emptyEl);
}

function paintHeader(): void {
  generatedBtn.classList.toggle('on', hideGenerated);
  generatedBtn.setAttribute('aria-pressed', String(hideGenerated));
  whitespaceBtn.classList.toggle('on', ignoreWhitespace);
  whitespaceBtn.setAttribute('aria-pressed', String(ignoreWhitespace));
  wrapBtn.classList.toggle('on', wrap);
  wrapBtn.setAttribute('aria-pressed', String(wrap));
  for (const [name, button] of layoutButtons) {
    button.classList.toggle('on', name === layout);
    button.setAttribute('aria-pressed', String(name === layout));
  }
}

/** Show which half owns the window; called by `code-area.ts` on every apply. */
export function paintDiffModeControl(mode: MainMode): void {
  if (!modeButtons) return;
  for (const [name, button] of modeButtons) {
    button.classList.toggle('on', name === mode);
    button.setAttribute('aria-pressed', String(name === mode));
  }
}

// ── building the scroll ───────────────────────────────────────────────────────

/**
 * Draw the whole surface from the answer as it now stands.
 *
 * The one thing that replaces every section, which is why it is reached only by
 * a header toggle or a new answer from git — never by a patch arriving, which
 * fills one body in place.
 */
function rebuild(): void {
  if (!mounts) return;
  paintHeader();

  const root = changesRoot();
  if (root !== shownRoot) {
    // A different checkout: every path and every patch belongs to a place the
    // reader has left.
    shownRoot = root;
    loaded.clear();
    expanded.clear();
    fetching.clear();
    queue.length = 0;
  }

  const payload = currentChangesPayload();
  if (payload === null) {
    current = null;
    clearSections();
    const failure = changesFailure();
    say(failure ?? (root === null
      ? 'Pick a project on the rail to read its changes.'
      : 'Reading what changed…'));
    worktreeEl.textContent = root === null ? '' : `⎇ ${basename(root)}`;
    baseEl.textContent = '';
    countsEl.textContent = '';
    noteEl.hidden = true;
    return;
  }

  current = buildDiffView(payload, { hideGenerated, ignoreWhitespace, expanded, loaded });
  drawHeaderFrom(current, root);
  drawBanner(current);

  if (current.sections.length === 0) {
    clearSections();
    if (current.totals.files === 0) {
      say(`Nothing has changed in this worktree ${baseText(current)}.`,
        { label: 'Browse files', act: openFilesTab });
    } else {
      say(`All ${current.totals.files} changed files are hidden. `
        + 'Turn a toggle back on above.');
    }
    return;
  }

  emptyEl.hidden = true;
  drawSections(current);
  fillVisible();
  focusIfAsked();
}

function drawHeaderFrom(view: DiffView, root: string | null): void {
  worktreeEl.textContent = root === null ? '' : `⎇ ${basename(root)}`;
  worktreeEl.title = root ?? '';

  baseEl.textContent = baseText(view);
  baseEl.title = view.base.kind === 'uncommitted'
    ? 'Everything not yet committed'
    : `Compared against ${baseLabel(view.base)}`;

  const { files, additions, deletions } = view.totals;
  countsEl.textContent = '';
  countsEl.appendChild(span('', `${files} file${files === 1 ? '' : 's'}`));
  if (additions > 0) countsEl.appendChild(span('diff-add-count', `+${group(additions)}`));
  if (deletions > 0) countsEl.appendChild(span('diff-del-count', `−${group(deletions)}`));

  // Invariant 7: git could not use the base that was asked for, so the header
  // says which one this really is instead of letting it imply the other.
  noteEl.hidden = !view.baseMismatch;
  noteEl.textContent = view.baseMismatch
    ? `${baseLabel(view.requestedBase)} could not be resolved here — showing ${baseLabel(view.base)}`
    : '';
}

function baseText(view: DiffView): string {
  return view.base.kind === 'uncommitted' ? 'uncommitted' : `vs ⎇ ${baseLabel(view.base)}`;
}

function drawBanner(view: DiffView): void {
  const hidden = view.generatedHidden;
  bannerEl.hidden = hidden === 0;
  if (hidden === 0) return;

  bannerEl.textContent = '';
  bannerEl.appendChild(span('diff-banner-text',
    `${hidden} generated file${hidden === 1 ? '' : 's'} hidden — build output, lockfiles `
    + 'and anything matched by .gitattributes linguist-generated.'));

  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'diff-pill diff-banner-btn';
  show.textContent = 'Show them';
  show.addEventListener('click', () => { hideGenerated = false; rebuild(); });
  bannerEl.appendChild(show);
}

/**
 * One empty box per file, in one go.
 *
 * Built as a single HTML string and handed to the parser once: 212 sections is
 * 212 sticky headers, and building them node by node is where a naive
 * implementation spends its first paint. Every body starts empty — the lines
 * are what `fillSection` adds, and only for the sections a reader gets near.
 */
function drawSections(view: DiffView): void {
  observer?.disconnect();
  elements.clear();
  releaseWatches();

  const html: string[] = [];
  for (const section of view.sections) {
    html.push(
      `<section class="diff-file" data-path="${esc(section.path)}"`
      + ` style="contain-intrinsic-size: auto ${estimatedHeight(section)}px">`
      + sectionHead(section)
      + '<div class="diff-file-body"></div>'
      + '</section>',
    );
  }
  scrollEl.innerHTML = html.join('');

  const built = scrollEl.querySelectorAll<HTMLElement>('.diff-file');
  observer = new IntersectionObserver(onIntersect, {
    root: scrollEl, rootMargin: OBSERVER_MARGIN,
  });
  for (const element of built) {
    const path = element.dataset.path;
    if (path === undefined) continue;
    elements.set(path, element);
    observer.observe(element);
  }
}

function clearSections(): void {
  observer?.disconnect();
  observer = null;
  elements.clear();
  releaseWatches();
  scrollEl.textContent = '';
}

/**
 * The line the surface shows when it has no sections to draw.
 *
 * `offer` is the way out, when there is one. "Nothing changed" is not an
 * apology — a clean worktree is a fine thing to be looking at — so it comes
 * with the move a reader actually wants next rather than a full stop. The base
 * switch that is the other half of that offer is already in the header above,
 * and stays there whether or not anything changed.
 */
function say(text: string, offer?: { label: string; act: () => void }): void {
  emptyEl.hidden = false;
  emptyEl.textContent = '';
  bannerEl.hidden = true;

  const line = document.createElement('div');
  line.textContent = text;
  emptyEl.appendChild(line);
  if (!offer) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'diff-pill diff-empty-action';
  button.textContent = offer.label;
  button.addEventListener('click', offer.act);
  emptyEl.appendChild(button);
}

// ── one section's header ──────────────────────────────────────────────────────

/**
 * The sticky bar: what happened, to which file, how big, and who did it.
 *
 * A rename says both paths here rather than in a body, which is the whole of
 * the "a rename is one line" rule: the header *is* the line, and there is
 * nothing under it to read.
 */
function sectionHead(section: DiffSection): string {
  const parts: string[] = [
    `<span class="diff-status is-${tone(section.status)}"`
    + ` title="${esc(STATUS_WORD[section.status] ?? section.status)}">${esc(section.status)}</span>`,
    pathHtml(section),
  ];

  if (!section.binary && !section.submodule) {
    if (section.additions > 0) {
      parts.push(`<span class="diff-add-count">+${group(section.additions)}</span>`);
    }
    if (section.deletions > 0) {
      parts.push(`<span class="diff-del-count">−${group(section.deletions)}</span>`);
    }
  }

  if (section.generated) parts.push(tag('generated'));
  if (section.whitespaceOnly) parts.push(tag('whitespace only'));
  if (section.binary) parts.push(tag('binary'));
  if (section.submodule) parts.push(tag('submodule'));
  if (section.untracked) parts.push(tag('untracked'));
  if (section.conflicted) parts.push(conflictTag(section));

  parts.push(claimsHtml(section));

  parts.push('<span class="diff-head-spacer"></span>');
  parts.push(actionsHtml(section));

  return `<header class="diff-file-head">${parts.join('')}</header>`;
}

/** `conflicted`, and how many separate conflicts once the patch is in hand. */
function conflictTag(section: DiffSection): string {
  const regions = conflictRegionsIn(loaded.get(section.path)?.hunks ?? section.hunks);
  const text = regions === 0
    ? 'conflicted'
    : `conflicted · ${regions} region${regions === 1 ? '' : 's'}`;
  return tag(text, 'is-conflict');
}

/**
 * Every session that claims this file, named, plus an amber mark when there is
 * more than one.
 *
 * The design's rule is that a file appears **once** whatever happened to it,
 * with each claimant on its header — which is what stops "two agents on one
 * file" reading as two unrelated changes. The mark is on the file and says so:
 * a claim is a path, a session and a time, and there is no line number
 * anywhere in it, so the moment this said "overlapping edit at line 208" it
 * would be inventing one. Per-hunk attribution is a different data source and
 * a later brief.
 */
function claimsHtml(section: DiffSection): string {
  const { claims, overlapping, edits } = attributionOf(section);
  if (claims.length === 0) return '';

  const named = claims.slice(0, MAX_NAMED_CLAIMS).map(claim => {
    const running = isRunning(claim.sessionId);
    return `<span class="diff-claim${running ? ' is-running' : ''}"`
      + ` title="${esc(`${claim.edits} edit${claim.edits === 1 ? '' : 's'}, last `
        + `${formatDate(new Date(claim.lastAtIso))}`)}">`
      + `${esc(sessionLabel(claim.sessionId))} · `
      + `${esc(formatDate(new Date(claim.lastAtIso)))}</span>`;
  });
  if (claims.length > MAX_NAMED_CLAIMS) {
    named.push(`<span class="diff-claim">+${claims.length - MAX_NAMED_CLAIMS} more</span>`);
  }

  if (overlapping) {
    named.unshift(`<span class="diff-tag is-overlap"`
      + ` title="${esc(`${claims.length} sessions and ${edits} edits on this one file. `
        + 'Claims are per file, not per line, so which lines they collided on is not '
        + 'known here.')}">${claims.length} sessions</span>`);
  }
  return named.join('');
}

/** Past this the header is a list of names rather than a header. */
const MAX_NAMED_CLAIMS = 3;

/** `src/renderer/` and `app.ts`, or `old → new` when the file moved. */
function pathHtml(section: DiffSection): string {
  const name = (path: string, className: string) => {
    const cut = path.lastIndexOf('/');
    const dirs = cut < 0 ? '' : `<span class="diff-dir">${esc(path.slice(0, cut + 1))}</span>`;
    return `<span class="${className}" title="${esc(path)}">${dirs}`
      + `<span class="diff-name">${esc(path.slice(cut + 1))}</span></span>`;
  };

  if (section.oldPath === undefined) {
    return name(section.path, section.status === 'D' ? 'diff-path is-gone' : 'diff-path');
  }
  const score = section.similarity === undefined ? '' : ` ${section.similarity}% similar`;
  return name(section.oldPath, 'diff-path is-old')
    + '<span class="diff-arrow">→</span>'
    + name(section.path, 'diff-path')
    + `<span class="diff-tag">${esc(`${section.status === 'C' ? 'copied' : 'renamed'}${score}`)}</span>`;
}

/**
 * `Open file` and `Revert`, or what stands in for them.
 *
 * A deleted file cannot be opened at the worktree because it is not there any
 * more, so it offers the base's copy instead — reconstructed from its own
 * patch, which for a deletion is the whole file. `Revert` is drawn and disabled:
 * there is no channel that writes to a worktree, and a button that silently
 * does nothing would be worse than one that says why.
 */
function actionsHtml(section: DiffSection): string {
  const open = section.status === 'D'
    ? `<button type="button" class="diff-pill" data-act="open-base"${remoteGuard(section)}>`
      + `Open at ${esc(baseLabelShort())}</button>`
    : `<button type="button" class="diff-pill" data-act="open">Open file</button>`;

  const revert = '<button type="button" class="diff-pill" data-act="revert" disabled'
    + ' title="Not wired: nothing in this app writes to a worktree yet.">Revert</button>';

  return open + revert;
}

function remoteGuard(section: DiffSection): string {
  if (!section.binary) return '';
  return ' disabled title="A binary file has no text to show at the base."';
}

/** How the base reads on a button. The ref alone: the bar above says the rest. */
function baseLabelShort(): string {
  if (current === null) return 'the base';
  return current.base.kind === 'uncommitted' ? 'HEAD' : `⎇ ${current.base.ref}`;
}

// ── one section's body ────────────────────────────────────────────────────────

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const path = (entry.target as HTMLElement).dataset.path;
    if (path !== undefined) fillSection(path);
  }
}

let fillHandle: number | undefined;

/**
 * Fill whatever is near the viewport, once per frame at most.
 *
 * The observer alone is not enough: it fires on boundary crossings, and a fast
 * flick can leave the queue behind the reader. The model's arithmetic answers
 * the same question from the scroll offset, so this is the belt to the
 * observer's braces, and both end at the same idempotent `fillSection`.
 */
function scheduleFill(): void {
  if (fillHandle !== undefined) return;
  fillHandle = requestAnimationFrame(() => {
    fillHandle = undefined;
    fillVisible();
  });
}

function fillVisible(): void {
  if (current === null) return;
  const heights = current.sections.map(estimatedHeight);
  const indices = visibleSections(heights, {
    scrollTop: scrollEl.scrollTop,
    height: scrollEl.clientHeight,
    overscan: DEFAULT_OVERSCAN,
  });
  for (const index of indices) {
    const section = current.sections[index];
    if (section !== undefined) fillSection(section.path);
  }
}

/**
 * Put a body under one header, buying its patch first if the body needs lines.
 *
 * Idempotent, and called from three places: the observer, the per-frame sweep,
 * and a patch arriving. `data-filled` is the whole of the bookkeeping — a body
 * whose content is already right is left alone, which is what stops a scroll
 * from re-rendering what it has already drawn.
 */
function fillSection(path: string): void {
  const element = elements.get(path);
  const section = current?.sections.find(candidate => candidate.path === path);
  if (!element || !section) return;

  const wants = needsPatch(section) && !loaded.has(path);
  const stamp = `${section.body}:${layout}:${wants ? 'pending' : 'ready'}`;
  if (element.dataset.filled === stamp) return;
  element.dataset.filled = stamp;

  const body = element.querySelector<HTMLElement>('.diff-file-body');
  if (!body) return;

  if (wants) {
    body.innerHTML = '<div class="diff-note">Reading the patch…</div>';
    enqueue(path);
    return;
  }
  body.innerHTML = bodyHtml(section);
  // Only now: a section whose body is on screen is a section whose staleness
  // the reader can act on. Watching every classified file would be 212 watches
  // for a diff nobody has scrolled through.
  drawn.add(path);
  watch(path);
}

/** Whether drawing this body means having the file's lines. */
function needsPatch(section: DiffSection): boolean {
  return section.body === 'hunks' || section.body === 'submodule';
}

/**
 * A section's body, with whatever has to be said above and below the lines.
 *
 * The bar at the top is the "this went stale under you" state and the strip at
 * the bottom is the conflict's actions; both wrap the ordinary body rather than
 * replacing it, because the lines are still the thing the reader came for.
 */
function bodyHtml(section: DiffSection): string {
  return staleHtml(section) + overlapHtml(section) + contentHtml(section)
    + conflictActionsHtml(section);
}

function contentHtml(section: DiffSection): string {
  switch (section.body) {
    case 'rename': return '';
    case 'none': return notesHtml(section) || '<div class="diff-note">No lines changed.</div>';
    case 'generated': return collapsedHtml(section,
      `Generated file — ${countText(section)} not rendered.`);
    case 'oversize': return collapsedHtml(section, section.conflicted
      ? `${countText(section)} — collapsed because the file is over 500, conflict and all.`
      : `${countText(section)} — collapsed because the file is over 500.`);
    case 'whitespace': return collapsedHtml(section,
      `Whitespace only — ${countText(section)} re-indented.`);
    case 'binary': return binaryHtml(section);
    case 'submodule': return submoduleHtml(section);
    case 'untracked': return '<div class="diff-note">Not in git yet — shown because a session '
      + 'wrote it. Open it to read the whole file.</div>';
    default: return hunksHtml(section);
  }
}

/**
 * The amber line a file gets when more than one session wrote it.
 *
 * It says what is known and stops. The canvas wanted "overlapping edit at line
 * 208"; the data cannot support a line number, so this says which sessions and
 * how many edits and admits the rest is not known here — see `attributionOf`.
 */
function overlapHtml(section: DiffSection): string {
  const { claims, overlapping, edits } = attributionOf(section);
  if (!overlapping) return '';
  const names = claims.map(claim => sessionLabel(claim.sessionId)).join(', ');
  return '<div class="diff-overlap">'
    + `<span>${esc(`${claims.length} sessions wrote this file — ${names} — `
      + `${edits} edits between them.`)}</span>`
    + '<span class="diff-overlap-caveat">Claims are per file, not per line: '
    + 'which lines they collided on is not known here.</span>'
    + '</div>';
}

/**
 * The bar that says a watcher saw this file change since it was drawn.
 *
 * Built in one place and used from two: `bodyHtml`, for a section that is
 * redrawn while already stale, and `paintStale`, which puts it on a section
 * without touching anything else in it.
 */
const STALE_BAR = '<div class="diff-stale">'
  + '<span>Changed on disk since this was read.</span>'
  + '<button type="button" class="diff-pill diff-stale-btn" data-act="reload">Reload</button>'
  + '</div>';

function staleHtml(section: DiffSection): string {
  return stale.has(section.path) ? STALE_BAR : '';
}

/**
 * `Keep ours`, `Keep theirs`, `Ask the session`.
 *
 * Invariant 10: conflicts are shown, never merged. The first two are drawn
 * disabled, and the reason on them is the honest one — **nothing in this app
 * writes to a worktree**, exactly as `Revert` says a few pixels away. They are
 * not omitted, because a reader looking for them should find out that this
 * surface has decided not to be a merge tool rather than wonder whether it
 * forgot.
 *
 * `Ask the session` is the one that does something, and it is the move this app
 * has that an editor does not: the file goes to a session that is already in
 * this worktree with the context to resolve it. Which session is
 * `askTarget`'s decision; when there is none it is disabled and says why,
 * because a prompt written into a dead terminal is lost without a sound.
 */
function conflictActionsHtml(section: DiffSection): string {
  if (!section.conflicted) return '';

  const regions = conflictRegionsIn(loaded.get(section.path)?.hunks ?? section.hunks);
  const target = askTarget(section.claims, sessionView.activeSessionId, runningSessions());
  const noWrite = 'Not wired: nothing in this app writes to a worktree yet. '
    + 'Switchboard shows a conflict — it does not merge it.';

  const ask = target === null
    ? '<button type="button" class="diff-pill" data-act="ask" disabled'
      + ' title="No session is running that could take this file. Open one in this'
      + ' worktree first.">Ask the session</button>'
    : '<button type="button" class="diff-pill is-primary" data-act="ask"'
      + ` title="${esc(`Types the prompt into ${sessionLabel(target.sessionId)}`
        + `${target.from === 'claim' ? ', which wrote this file' : ', the session on screen'}`
        + '. You press Return.')}">Ask the session</button>`;

  return '<div class="diff-conflict-actions">'
    + `<span class="diff-conflict-note">${esc(regions === 0
      ? 'git left both sides in this file.'
      : `git left both sides in this file, in ${regions} place${regions === 1 ? '' : 's'}.`)}`
    + '</span>'
    + `<button type="button" class="diff-pill" data-act="keep-ours" disabled`
    + ` title="${esc(noWrite)}">Keep ours</button>`
    + `<button type="button" class="diff-pill" data-act="keep-theirs" disabled`
    + ` title="${esc(noWrite)}">Keep theirs</button>`
    + ask
    + '</div>';
}

function collapsedHtml(section: DiffSection, text: string): string {
  return `<div class="diff-folded"><span>${esc(text)}</span>`
    + '<button type="button" class="diff-pill" data-act="expand">Expand</button></div>';
}

function countText(section: DiffSection): string {
  const lines = section.additions + section.deletions;
  return `${group(lines)} changed line${lines === 1 ? '' : 's'}`;
}

/**
 * A binary file: its sizes, and a thumbnail when the new side is an image.
 *
 * Only the new side. The base's copy of a blob would need a channel that can
 * read one at a ref, and there is none — so rather than draw a half-empty pair
 * of thumbnails and let it read as "the image was blank before", the missing
 * side says what is missing. `file://` is the renderer's own origin (the window
 * is opened with `loadFile`), which is what makes the local one free; a remote
 * worktree has no local path and gets no thumbnail at all.
 */
function binaryHtml(section: DiffSection): string {
  const root = shownRoot;
  const showable = root !== null && !isRemoteProjectPath(root)
    && section.status !== 'D' && isImage(section.path);

  const before = '<div class="diff-thumb is-missing"><span>base copy</span>'
    + '<span class="diff-thumb-note">not readable — no channel reads a blob at a ref</span></div>';
  const after = showable
    ? `<div class="diff-thumb"><img src="file://${encodeURI(`${root}/${section.path}`)}" alt="">`
      + '<span class="diff-thumb-note">now</span></div>'
    : '';

  const note = `<div class="diff-note">Binary — git counts no lines for it.`
    + `${section.status === 'D' ? ' Deleted at this base.' : ''}</div>`;
  return showable ? `<div class="diff-thumbs">${before}${after}</div>${note}` : note;
}

/**
 * A submodule: the two pointer lines and nothing else.
 *
 * Never the submodule's own diff — that is a different repository, and a
 * different tile on the rail.
 */
function submoduleHtml(section: DiffSection): string {
  const file = loaded.get(section.path);
  const lines = file?.hunks.flatMap(hunk => hunk.lines) ?? [];
  const pointers = lines.filter(line => line.kind !== 'ctx');
  if (pointers.length === 0) {
    return '<div class="diff-note">Submodule pointer moved. git prints no lines for it here.</div>';
  }
  const rows = pointers.map(line =>
    `<div class="diff-line ${line.kind === 'add' ? 'is-add' : 'is-del'}">`
    + `<span class="diff-ln">${line.kind === 'add' ? '+' : '−'}</span>`
    + `<span class="diff-code">${esc(line.text)}</span></div>`).join('');
  return `<div class="diff-lines">${rows}</div>`
    + `<div class="diff-note">${pointers.length} pointer line`
    + `${pointers.length === 1 ? '' : 's'} — the submodule's own history is its own repository.</div>`;
}

/** Every hunk of a file, plus the notes git printed under them. */
function hunksHtml(section: DiffSection): string {
  const file = loaded.get(section.path);
  const hunks = file?.hunks ?? section.hunks;
  if (hunks.length === 0) return '<div class="diff-note">git reported no lines for this file.</div>';

  const lang = section.whitespaceOnly ? null : languageFor(section.path);
  const html = hunks.map(hunk => layout === 'side-by-side'
    ? splitHunk(hunk, lang, section)
    : unifiedHunk(hunk, lang, section)).join('');
  return html + notesHtml(section);
}

/**
 * The notes that would otherwise be silent differences.
 *
 * A mode change and a missing final newline are real differences between two
 * files that a hunk cannot show, and git says both — so this does too, in one
 * line each under the lines they belong to.
 */
function notesHtml(section: DiffSection): string {
  const notes: string[] = [];
  if (section.modeChange) {
    notes.push(`mode changed ${section.modeChange.from} → ${section.modeChange.to}`);
  }
  if (section.noNewlineAtEof) {
    notes.push(section.noNewlineAtEof === 'both'
      ? '\\ No newline at end of file, on both sides'
      : `\\ No newline at end of file, on the ${section.noNewlineAtEof} side`);
  }
  return notes.map(note => `<div class="diff-note is-git">${esc(note)}</div>`).join('');
}

function unifiedHunk(hunk: Hunk, lang: ReturnType<typeof languageFor>, section: DiffSection): string {
  const coloured = colour(hunk.lines, lang, section);
  const roles = rolesFor(hunk, section);
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;

  const rows: string[] = [`<div class="diff-hunk-head">${esc(hunk.header)}</div>`];
  hunk.lines.forEach((line, index) => {
    const left = line.kind === 'add' ? '' : String(oldNo++);
    const right = line.kind === 'del' ? '' : String(newNo++);
    rows.push(`<div class="diff-line ${kindClass(line)}${roleClass(roles[index])}">`
      + `<span class="diff-ln">${left}</span><span class="diff-ln">${right}</span>`
      + `<span class="diff-code">${coloured[index]}</span></div>`);
  });
  return `<div class="diff-lines">${rows.join('')}</div>`;
}

/**
 * Which rows of this hunk are conflict markers, and which side each one is on.
 *
 * Only asked of a conflicted file. git writes a conflict into the file itself,
 * so these rows arrive as ordinary `+` lines and would otherwise draw as one
 * undifferentiated green block — the exact opposite of showing a reader the
 * shape of the thing they have to decide about.
 */
function rolesFor(hunk: Hunk, section: DiffSection): (ConflictRole | null)[] {
  if (!section.conflicted) return [];
  return conflictRoles(hunk.lines.map(line => line.text));
}

function roleClass(role: ConflictRole | null | undefined): string {
  switch (role) {
    case 'start': case 'end': return ' is-conflict-marker';
    case 'separator': return ' is-conflict-split';
    case 'base-marker': return ' is-conflict-marker is-base';
    case 'ours': return ' is-ours';
    case 'theirs': return ' is-theirs';
    case 'base': return ' is-base';
    default: return '';
  }
}

/**
 * The same hunk as two columns.
 *
 * Deletions and the additions that follow them are paired run by run, which is
 * what makes a one-line edit read as one row with both spellings on it rather
 * than as two rows a screen apart. A run with more of one side than the other
 * pads with blanks, because a diff is not a bijection.
 */
function splitHunk(hunk: Hunk, lang: ReturnType<typeof languageFor>, section: DiffSection): string {
  const coloured = colour(hunk.lines, lang, section);
  const roles = rolesFor(hunk, section);
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;

  const rows: string[] = [`<div class="diff-hunk-head">${esc(hunk.header)}</div>`];
  let dels: number[] = [];
  let adds: number[] = [];

  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const del = dels[i];
      const add = adds[i];
      rows.push('<div class="diff-row">'
        + side(del === undefined ? null : { no: oldNo + i, html: coloured[del] },
          `is-del${roleClass(roles[del ?? -1])}`)
        + side(add === undefined ? null : { no: newNo + i, html: coloured[add] },
          `is-add${roleClass(roles[add ?? -1])}`)
        + '</div>');
    }
    oldNo += dels.length;
    newNo += adds.length;
    dels = [];
    adds = [];
  };

  hunk.lines.forEach((line, index) => {
    if (line.kind === 'del') { dels.push(index); return; }
    if (line.kind === 'add') { adds.push(index); return; }
    flush();
    const role = roleClass(roles[index]);
    rows.push('<div class="diff-row">'
      + side({ no: oldNo++, html: coloured[index] }, role)
      + side({ no: newNo++, html: coloured[index] }, role)
      + '</div>');
  });
  flush();

  return `<div class="diff-lines is-split">${rows.join('')}</div>`;
}

function side(cell: { no: number; html: string } | null, tone: string): string {
  if (cell === null) return '<div class="diff-cell is-blank"></div>';
  return `<div class="diff-cell ${tone}"><span class="diff-ln">${cell.no}</span>`
    + `<span class="diff-code">${cell.html}</span></div>`;
}

function kindClass(line: HunkLine): string {
  // Deliberately not `.tok-inserted` / `.tok-deleted`: those already belong to
  // languages that mark tokens that way, and `_code-highlight.scss` paints them
  // as string and comment colours.
  return line.kind === 'add' ? 'is-add' : line.kind === 'del' ? 'is-del' : '';
}

/**
 * One HTML string per line, coloured where colouring is affordable.
 *
 * The whole hunk goes through the highlighter in one call, because a line torn
 * out of its file is rarely valid syntax on its own. A whitespace-only file
 * skips colouring entirely and gets its leading indentation made visible
 * instead — which is the only way to see a change that is, by definition,
 * invisible.
 *
 * The cap is `colourable`'s, and it is what a minified bundle runs into: one
 * added line of 1.6 MB comes back escaped rather than parsed, which is every
 * character of the change in the right place with no colour on it. Invariant 9
 * then keeps it on one row that scrolls sideways. `highlightLines` refuses the
 * same block for the same reasons — asking here as well only saves building
 * the array to hand over.
 */
function colour(
  lines: readonly HunkLine[], lang: ReturnType<typeof languageFor>, section: DiffSection,
): string[] {
  const texts = lines.map(line => line.text);
  if (section.whitespaceOnly) return texts.map(visibleIndent);
  if (!colourable(texts)) return texts.map(esc);
  return highlightLines(texts, lang);
}

function visibleIndent(text: string): string {
  const match = /^[ \t]+/.exec(text);
  if (match === null) return esc(text);
  const shown = match[0].replace(/ /g, '·').replace(/\t/g, '→ ');
  return `<span class="diff-ws">${esc(shown)}</span>${esc(text.slice(match[0].length))}`;
}

const languages = new Map<string, ReturnType<typeof highlightLanguageFor>>();

function languageFor(path: string): ReturnType<typeof highlightLanguageFor> {
  const known = languages.get(path);
  if (known !== undefined) return known;
  const resolved = highlightLanguageFor(path);
  languages.set(path, resolved);
  return resolved;
}

// ── phase two: buying one file's lines ────────────────────────────────────────

function enqueue(path: string): void {
  if (fetching.has(path) || loaded.has(path)) return;
  fetching.add(path);
  queue.push(path);
  pump();
}

function pump(): void {
  while (running < FETCH_LIMIT) {
    const path = queue.shift();
    if (path === undefined) return;
    running++;
    void fetchPatch(path).finally(() => { running--; pump(); });
  }
}

/**
 * One file's hunks, and the language its lines will be coloured with.
 *
 * The language is resolved here rather than at paint time because ~100 of them
 * only resolve asynchronously, and a scroll being built right now cannot wait —
 * so the wait is spent alongside the git process, which is where there is
 * already one.
 */
async function fetchPatch(path: string): Promise<FileDiff | null> {
  const root = shownRoot;
  const base = current?.base ?? currentChangesPayload()?.base;
  if (root === null || base === undefined) { fetching.delete(path); return null; }

  try {
    const [file] = await Promise.all([
      window.api.gitDiffFile(root, base, path),
      resolveLanguage(path),
    ]);
    fetching.delete(path);
    if (shownRoot !== root) return null;
    if (!Array.isArray(file?.hunks)) {
      failSection(path, errorOf(file) ?? 'git could not read this file');
      return null;
    }
    loaded.set(path, file);
    // A file that turns out to be whitespace-only, or bigger than its row said,
    // draws differently now — but it is *not* re-sorted, because moving a
    // section the reader is looking at is worse than showing it out of order
    // until the next rebuild.
    rebuildSection(path);
    return file;
  } catch (err) {
    fetching.delete(path);
    failSection(path, err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function resolveLanguage(path: string): Promise<void> {
  if (languages.has(path)) return;
  languages.set(path, await loadHighlightLanguage(path));
}

function errorOf(answer: unknown): string | null {
  const error = (answer as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error !== '' ? error : null;
}

function failSection(path: string, message: string): void {
  const body = elements.get(path)?.querySelector<HTMLElement>('.diff-file-body');
  if (body) body.innerHTML = `<div class="diff-note is-error">${esc(message)}</div>`;
}

/**
 * Redraw one section in place, keeping every other section where it was.
 *
 * The section's own `DiffSection` is rebuilt from the newly loaded file so its
 * body decision is made with what phase two now knows, and the array is patched
 * rather than re-sorted — see the note in `fetchPatch`.
 */
function rebuildSection(path: string): void {
  if (current === null) return;
  const index = current.sections.findIndex(section => section.path === path);
  if (index < 0) return;

  const payload = currentChangesPayload();
  if (payload === null) return;
  const rebuilt = buildDiffView(payload, { hideGenerated, ignoreWhitespace, expanded, loaded })
    .sections.find(section => section.path === path);
  if (rebuilt === undefined) return;

  current.sections[index] = rebuilt;
  const element = elements.get(path);
  if (element === undefined) return;
  element.style.containIntrinsicSize = `auto ${estimatedHeight(rebuilt)}px`;
  const head = element.querySelector<HTMLElement>('.diff-file-head');
  if (head) head.outerHTML = sectionHead(rebuilt);
  delete element.dataset.filled;
  fillSection(path);
}

// ── clicks ────────────────────────────────────────────────────────────────────

function onBodyClick(event: MouseEvent): void {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
  if (button === null || button === undefined) return;
  const path = button.closest<HTMLElement>('.diff-file')?.dataset.path;
  if (path === undefined) return;

  switch (button.dataset.act) {
    case 'expand':
      expanded.add(path);
      rebuildSection(path);
      break;
    case 'open':
      void openWhole(path);
      break;
    case 'open-base':
      void openAtBase(path);
      break;
    case 'reload':
      reloadSection(path);
      break;
    case 'ask':
      askTheSession(path, button);
      break;
    default:
      break;
  }
}

// ── changed underneath you ────────────────────────────────────────────────────

/**
 * A watcher fired: mark the section, do not touch it.
 *
 * The whole point is that nothing moves. Re-reading the patch here would
 * replace the lines the reader is in the middle of and change the section's
 * height, which on a long scroll means the place they were reading walks off
 * the screen — and a session mid-run fires this every few seconds. So the
 * section dims and grows a `Reload`, and the reader decides when.
 */
function onDiskChange(changedPath: string): void {
  const next = markStale(stale, drawn, shownRoot, changedPath);
  for (const path of next) {
    if (stale.has(path)) continue;
    stale.add(path);
    paintStale(path);
  }
}

/** Put the bar at the top of one section's body, leaving the lines alone. */
function paintStale(path: string): void {
  const element = elements.get(path);
  const body = element?.querySelector<HTMLElement>('.diff-file-body');
  if (!element || !body || body.querySelector('.diff-stale') !== null) return;
  element.classList.add('is-stale');
  body.insertAdjacentHTML('afterbegin',
    '<div class="diff-stale">'
    + '<span>Changed on disk since this was read.</span>'
    + '<button type="button" class="diff-pill diff-stale-btn" data-act="reload">Reload</button>'
    + '</div>');
}

/** `Reload`: throw away this file's patch and buy it again, in place. */
function reloadSection(path: string): void {
  stale.delete(path);
  elements.get(path)?.classList.remove('is-stale');
  loaded.delete(path);
  fetching.delete(path);
  rebuildSection(path);
}

/**
 * Ask the main process to watch one file, within a bounded set.
 *
 * Remote worktrees are skipped: the path is an `ssh://` spelling that no local
 * `fs.watch` can open, and asking would only collect an error per file.
 */
function watch(path: string): void {
  const root = shownRoot;
  if (root === null || isRemoteProjectPath(root)) return;

  const next = nextWatched(watched, path);
  if (next.watched.length === watched.length && next.released.length === 0) return;
  watched = next.watched;
  for (const gone of next.released) void window.api.unwatchFile(absolute(root, gone));
  void window.api.watchFile(absolute(root, path));
}

function releaseWatches(): void {
  const root = shownRoot;
  if (root !== null && !isRemoteProjectPath(root)) {
    for (const path of watched) void window.api.unwatchFile(absolute(root, path));
  }
  watched = [];
  drawn.clear();
  stale.clear();
}

function absolute(root: string, relPath: string): string {
  return `${root.replace(/\/+$/, '')}/${relPath}`;
}

// ── handing a conflict to a session ───────────────────────────────────────────

/** Sessions with a live PTY *and* a terminal here to show what was typed. */
function runningSessions(): Set<string> {
  const live = new Set<string>();
  for (const [sessionId, entry] of openSessions) {
    if (entry.closed !== true && sessionView.activePtyIds.has(sessionId)) live.add(sessionId);
  }
  return live;
}

function isRunning(sessionId: string): boolean {
  const entry = openSessions.get(sessionId);
  return entry !== undefined && entry.closed !== true
    && sessionView.activePtyIds.has(sessionId);
}

/**
 * Hand a conflicted file to a session: type the prompt, and stop there.
 *
 * **Typed, not sent.** The text goes into the session's composer and the flip
 * lands on it with the cursor at the end; the Return is the reader's. Two
 * reasons, and the second is the load-bearing one. It is a message that will
 * appear in their name, so they should see it before it goes. And a running
 * CLI is not always sitting at an empty prompt — it may be asking whether to
 * allow a tool call — and a Return we send there answers a question we never
 * read.
 *
 * The target is recomputed at the click rather than trusted from the paint: a
 * session can exit between a body being drawn and a button being pressed, and
 * that is exactly the case where the prompt would vanish without a trace.
 */
function askTheSession(path: string, button: HTMLElement): void {
  const section = current?.sections.find(candidate => candidate.path === path);
  if (section === undefined) return;

  const target = askTarget(section.claims, sessionView.activeSessionId, runningSessions());
  if (target === null) {
    button.setAttribute('disabled', '');
    button.title = 'That session is no longer running. Open one in this worktree first.';
    return;
  }

  const regions = conflictRegionsIn(loaded.get(path)?.hunks ?? section.hunks);
  window.api.sendInput(target.sessionId, conflictPrompt(path, regions));
  showSession(target.sessionId);
  // Last: `showSession` restores that session's own half, and the point of
  // sending is that the reader is now in the conversation.
  handlers?.onPickMode('talk');
}

/** `Open file`: the file as it is now, with the diff's lines marked in it. */
async function openWhole(path: string): Promise<void> {
  const root = shownRoot;
  if (root === null || handlers === null) return;
  const file = loaded.get(path) ?? await fetchPatch(path);
  handlers.onOpenFile({
    worktreePath: root,
    relPath: path,
    changedLines: file === null ? [] : newSideLines(file.hunks),
  });
}

/**
 * `Open at <base>`: the deleted file, rebuilt from its own patch.
 *
 * A deletion's patch is the whole file — every line of it is a `-` — so the old
 * text is already on the wire, and reading it needs no second channel that can
 * fetch a blob at a ref.
 */
async function openAtBase(path: string): Promise<void> {
  const root = shownRoot;
  if (root === null || handlers === null) return;
  const file = loaded.get(path) ?? await fetchPatch(path);
  if (file === null) return;

  const text = file.hunks
    .flatMap(hunk => hunk.lines.filter(line => line.kind !== 'add').map(line => line.text))
    .join('\n');
  handlers.onOpenFile({
    worktreePath: root, relPath: path, changedLines: [], contentAtBase: text,
  });
}

/** Every line of the new side a hunk touched, 1-based, ascending. */
function newSideLines(hunks: readonly Hunk[]): number[] {
  const lines: number[] = [];
  for (const hunk of hunks) {
    let no = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === 'del') continue;
      if (line.kind === 'add') lines.push(no);
      no++;
    }
  }
  return lines;
}

function focusIfAsked(): void {
  const path = pendingFocus;
  pendingFocus = null;
  if (path === null) return;
  const element = elements.get(path);
  if (element === undefined) return;
  element.scrollIntoView({ block: 'start' });
  element.classList.add('is-focused');
  fillSection(path);
}

// ── small shared pieces ───────────────────────────────────────────────────────

/**
 * What a session is called here.
 *
 * The same three sources the sidebar's row uses, resolved locally: a session
 * the renderer has never heard of still gets an identity, because a header that
 * named nobody would be worse than a short id.
 */
function sessionLabel(sessionId: string): string {
  const session = sessionMap.get(sessionId);
  const name = session
    ? cleanDisplayName(session.name || session.aiTitle || session.summary)
    : null;
  return name || shortSessionId(sessionId);
}

function tone(status: string): string {
  switch (status) {
    case 'A': case '?': return 'add';
    case 'M': return 'mod';
    case 'D': return 'del';
    case 'U': return 'conflict';
    default: return 'plain';
  }
}

function tag(text: string, extra = ''): string {
  return `<span class="diff-tag ${extra}">${esc(text)}</span>`;
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path);
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

/** `18904` → `18,904`. A five-figure diffstat is unreadable without it. */
function group(value: number): string {
  return value.toLocaleString('en-US');
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * Escape for interpolation into HTML.
 *
 * Local rather than `lib/format`'s: that one round-trips through
 * `document.createElement`, and this is called once per path, per tag and per
 * uncoloured line — hundreds of thousands of elements on a big diff. Every
 * string this file puts into `innerHTML` goes through here or through
 * `highlightLines`, which escapes its own output.
 */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

function span(className: string, text = ''): HTMLElement {
  const el = document.createElement('span');
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function pill(className: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `diff-pill ${className}`;
  return el;
}

function toggle(text: string, hint: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'diff-pill diff-toggle';
  button.textContent = text;
  button.title = hint;
  button.addEventListener('click', onClick);
  return button;
}

function segmented<T extends string>(
  host: HTMLElement, label: string, options: readonly (readonly [T, string])[],
  pick: (value: T) => void,
): Map<T, HTMLButtonElement> {
  const group_ = document.createElement('div');
  group_.className = 'sb-segmented';
  group_.setAttribute('role', 'group');
  group_.setAttribute('aria-label', label);

  const buttons = new Map<T, HTMLButtonElement>();
  for (const [value, text] of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-segment';
    button.textContent = text;
    button.addEventListener('click', () => pick(value));
    group_.appendChild(button);
    buttons.set(value, button);
  }
  host.appendChild(group_);
  return buttons;
}
