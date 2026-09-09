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
 * The rules — what a section is, which body it draws, what order they come in,
 * what the counts add up to, and which sections are worth building right now —
 * are in `diff-view-model.ts`, which has no DOM in it and is tested directly.
 */
import {
  DEFAULT_OVERSCAN, buildDiffView, estimatedHeight, primaryClaim, visibleSections,
} from './diff-view-model';
import { baseLabel } from '../files/changes-list-model';
import { changesFailure, changesRoot, currentChangesPayload, ensureChangesLoaded, onChangesChanged } from '../files/changes-list';
import { cleanDisplayName } from '../../../domain/session/title';
import { formatDate, shortcutLabel } from '../../lib/format';
import { highlightLanguageFor, highlightLines, loadHighlightLanguage } from '../../lib/highlight-static';
import { isRemoteProjectPath } from '../../../domain/project/remote-target';
import { sessionMap } from '../../state/session-store';
import { shortSessionId } from '../files/changes-list-model';
import type { DiffSection, DiffView } from './diff-view-model';
import type { FileDiff, Hunk, HunkLine } from '../../../domain/git/types';
import type { MainMode } from '../../app/main-mode-model';

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

/** Beyond this a hunk is not coloured — `highlight-static` has the reasons. */
const MAX_HUNK_LINES = 1200;

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
  rebuild();
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
    () => { ignoreWhitespace = !ignoreWhitespace; rebuild(); });
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
    say(current.totals.files === 0
      ? `Nothing has changed in this worktree ${baseText(current)}.`
      : `All ${current.totals.files} changed files are hidden. Turn a toggle back on above.`);
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
  scrollEl.textContent = '';
}

function say(text: string): void {
  emptyEl.hidden = false;
  emptyEl.textContent = text;
  bannerEl.hidden = true;
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
  if (section.status === 'U') parts.push(tag('conflicted', 'is-conflict'));

  const claim = primaryClaim(section);
  if (claim !== null) {
    const extra = section.claims.length > 1 ? ` · ${section.claims.length} sessions` : '';
    parts.push(`<span class="diff-claim">${esc(sessionLabel(claim.sessionId))} · `
      + `${esc(formatDate(new Date(claim.lastAtIso)))}${esc(extra)}</span>`);
  }

  parts.push('<span class="diff-head-spacer"></span>');
  parts.push(actionsHtml(section));

  return `<header class="diff-file-head">${parts.join('')}</header>`;
}

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
}

/** Whether drawing this body means having the file's lines. */
function needsPatch(section: DiffSection): boolean {
  return section.body === 'hunks' || section.body === 'submodule';
}

function bodyHtml(section: DiffSection): string {
  switch (section.body) {
    case 'rename': return '';
    case 'none': return notesHtml(section) || '<div class="diff-note">No lines changed.</div>';
    case 'generated': return collapsedHtml(section,
      `Generated file — ${countText(section)} not rendered.`);
    case 'oversize': return collapsedHtml(section,
      `${countText(section)} — collapsed because the file is over 500.`);
    case 'whitespace': return collapsedHtml(section,
      `Whitespace only — ${countText(section)} re-indented.`);
    case 'binary': return binaryHtml(section);
    case 'submodule': return submoduleHtml(section);
    case 'untracked': return '<div class="diff-note">Not in git yet — shown because a session '
      + 'wrote it. Open it to read the whole file.</div>';
    default: return hunksHtml(section);
  }
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
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;

  const rows: string[] = [`<div class="diff-hunk-head">${esc(hunk.header)}</div>`];
  hunk.lines.forEach((line, index) => {
    const left = line.kind === 'add' ? '' : String(oldNo++);
    const right = line.kind === 'del' ? '' : String(newNo++);
    rows.push(`<div class="diff-line ${kindClass(line)}">`
      + `<span class="diff-ln">${left}</span><span class="diff-ln">${right}</span>`
      + `<span class="diff-code">${coloured[index]}</span></div>`);
  });
  return `<div class="diff-lines">${rows.join('')}</div>`;
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
        + side(del === undefined ? null : { no: oldNo + i, html: coloured[del] }, 'is-del')
        + side(add === undefined ? null : { no: newNo + i, html: coloured[add] }, 'is-add')
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
    rows.push('<div class="diff-row">'
      + side({ no: oldNo++, html: coloured[index] }, '')
      + side({ no: newNo++, html: coloured[index] }, '')
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
 */
function colour(
  lines: readonly HunkLine[], lang: ReturnType<typeof languageFor>, section: DiffSection,
): string[] {
  const texts = lines.map(line => line.text);
  if (section.whitespaceOnly) return texts.map(visibleIndent);
  if (texts.length > MAX_HUNK_LINES) return texts.map(esc);
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
    default:
      break;
  }
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
