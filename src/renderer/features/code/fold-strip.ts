/**
 * The folded half, as one line along the bottom.
 *
 * Invariant 1 says the half you are not in never closes, and invariant 2 says
 * folding is a size change rather than a teardown. Both strips are therefore
 * built once, at install, and only ever hidden — and each is built into the half
 * it belongs to, so folding really is that half shrinking to 36px rather than
 * anything moving between containers:
 *
 *   - the code strip is the last child of `#terminal-area`, shown in `talk`
 *   - the conversation strip is the last child of `#code-area`, shown in `code`
 *
 * In `split` neither shows: both halves are already on screen, and a strip
 * summarising something the user can see is furniture.
 *
 * One component parameterised by side. What differs is the middle — what the
 * folded half is currently *about* — and both ends are identical: a chevron on
 * the left, `⌘J` on the right, and the whole width a click target that brings
 * that half back.
 *
 * Neither strip fetches anything. The code strip reads the Changes list's
 * answer, which is one `getChanges` round trip shared with the sidebar; the
 * conversation strip reads the live xterm buffer, which costs nothing and is
 * the only place the last thing said actually exists.
 */
import { badgeFor } from '../rail/rail-model';
import { cleanDisplayName } from '../../../domain/session/title';
import {
  changesFailure, currentChangesView, ensureChangesLoaded, onChangesChanged, openChangedFile,
} from '../files/changes-list';
import { baseLabel, statusTone } from '../files/changes-list-model';
import { codeArea, terminalArea } from '../../lib/dom';
import { lastMessageLine } from '../../app/main-mode-model';
import { openSessions, sessionMap, view } from '../../state/session-store';
import { shortcutLabel } from '../../lib/format';
import { onActivityChange, signalsFor } from '../../state/activity-store';
import type { MainMode } from '../../app/main-mode-model';
import type { OpenSession } from '../../state/session-store';

/** What the strips need from the flip they belong to. */
export interface FoldStripHandlers {
  /** The whole strip was clicked: bring this half back. */
  onExpand: () => void;
  /** A file chip was clicked: the code side has to own the window first. */
  onShowCode: () => void;
}

/** How many rows back to look for the last thing the CLI said. */
const TAIL_ROWS = 80;

/** How many file chips are worth building for a row that cannot scroll. */
const MAX_CHIPS = 24;

/** A chevron pointing at the half that is folded away, above the strip. */
const CHEVRON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>';

let codeStrip: HTMLElement | null = null;
let conversationStrip: HTMLElement | null = null;

/** Filled per strip at build time, so a redraw replaces content and not nodes. */
interface CodeStripParts {
  count: HTMLElement;
  stat: HTMLElement;
  base: HTMLElement;
  chips: HTMLElement;
}
interface ConversationStripParts {
  dot: HTMLElement;
  name: HTMLElement;
  line: HTMLElement;
}
let codeParts: CodeStripParts | null = null;
let conversationParts: ConversationStripParts | null = null;

/**
 * Build both strips, hidden.
 *
 * After `initFilePanel` and `installCodeArea`, because each strip is appended
 * to a half those two have finished assembling — the code strip has to come
 * after `#terminal-split`, or the split would sit below it.
 */
export function installFoldStrips(handlers: FoldStripHandlers): void {
  if (codeStrip) return;

  codeStrip = buildCodeStrip(handlers);
  terminalArea.appendChild(codeStrip);

  conversationStrip = buildConversationStrip(handlers);
  codeArea.appendChild(conversationStrip);

  // The answer can arrive long after the strip is drawn, and it changes every
  // number on it. Redrawing the whole strip is cheap — four text nodes and a
  // row of chips — and is what keeps the count honest without a poll.
  onChangesChanged(() => { if (isShown(codeStrip)) drawCodeStrip(); });

  // A session goes on talking while you read its code, and invariant 4 says
  // nothing goes quiet: the folded strip is the only thing on screen speaking
  // for it, so its dot and its last line follow the same transitions the
  // sidebar's row does rather than freezing at whatever was true on the flip.
  onActivityChange(() => { if (isShown(conversationStrip)) drawConversationStrip(); });
}

/**
 * Show the strip for the folded half and hide the other, or hide both.
 *
 * Hidden outright when there is no session to fold or the grid has the window:
 * the flip is one session's gesture, and a strip summarising "the conversation"
 * while nine of them are on screen names nothing.
 */
export function renderFoldStrips(mode: MainMode): void {
  if (!codeStrip || !conversationStrip) return;

  const foldable = view.activeSessionId !== null && !view.gridViewActive;
  const showCode = foldable && mode === 'talk';
  const showConversation = foldable && mode === 'code';

  codeStrip.hidden = !showCode;
  conversationStrip.hidden = !showConversation;

  if (showCode) {
    // Asked for here rather than at install: until the conversation is folded
    // nobody is looking at the answer, and a diff of the whole worktree is the
    // expensive call on this surface.
    ensureChangesLoaded();
    drawCodeStrip();
  }
  if (showConversation) drawConversationStrip();
}

/**
 * Fold both strips away, whatever the mode says.
 *
 * For the grid, which takes `#terminal-area` for itself: the strips live inside
 * that area, so leaving one up would cost the grid 36px to say something about a
 * single session while nine of them are on screen. Asked of the strips' one
 * owner rather than reached for by id, which is how the grid already asks
 * `viewers.ts` to put the panels down. Leaving the grid goes through
 * `showSession`, which re-applies the mode and brings the right strip back.
 */
export function hideFoldStrips(): void {
  if (codeStrip) codeStrip.hidden = true;
  if (conversationStrip) conversationStrip.hidden = true;
}

function isShown(strip: HTMLElement | null): boolean {
  return strip !== null && !strip.hidden;
}

// ── the shared shape ──────────────────────────────────────────────────────────

/**
 * The chrome both strips have: the chevron, and the `⌘J` hint after a spacer.
 *
 * The click is on the strip rather than on the chevron. A one-line strip is
 * already the smallest target the window has, and asking the user to hit an
 * 11px glyph inside it would make the cheap half of the flip the expensive one.
 */
function buildStrip(id: string, hint: string, onExpand: () => void): HTMLElement {
  const strip = document.createElement('div');
  strip.id = id;
  strip.className = 'fold-strip';
  strip.hidden = true;
  strip.title = hint;
  strip.addEventListener('click', () => onExpand());

  const chevron = document.createElement('span');
  chevron.className = 'fold-chevron';
  chevron.innerHTML = CHEVRON;
  strip.appendChild(chevron);

  return strip;
}

/** The right-hand end: a spacer that eats the slack, then the shortcut. */
function closeStrip(strip: HTMLElement): void {
  const spacer = document.createElement('span');
  spacer.className = 'fold-spacer';
  strip.appendChild(spacer);

  const kbd = document.createElement('span');
  kbd.className = 'fold-kbd';
  kbd.textContent = shortcutLabel('J');
  strip.appendChild(kbd);
}

function span(className: string, text = ''): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

// ── the code half, folded ─────────────────────────────────────────────────────

function buildCodeStrip(handlers: FoldStripHandlers): HTMLElement {
  const strip = buildStrip('fold-strip-code', `What changed — ${shortcutLabel('J')}`, handlers.onExpand);

  strip.appendChild(span('fold-label', 'Changes'));

  const count = span('fold-count');
  const stat = span('fold-stat');
  const base = span('fold-base');
  strip.append(count, stat, base);

  const chips = document.createElement('div');
  chips.className = 'fold-chips';
  // Delegated, because the chips are replaced on every redraw: a listener per
  // chip would be re-attached for every file on every answer.
  chips.addEventListener('click', event => {
    const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>('.fold-chip');
    const path = chip?.dataset.path;
    if (path === undefined) return;
    // The chip is inside the strip, whose own click expands this half. Both
    // want the code side; only the chip also wants a particular file, and
    // letting the strip's handler run too would flip twice.
    event.stopPropagation();
    handlers.onShowCode();
    openChangedFile(path);
  });
  strip.appendChild(chips);

  closeStrip(strip);
  codeParts = { count, stat, base, chips };
  return strip;
}

/**
 * Redraw the numbers and the chips.
 *
 * With no answer yet the strip says so rather than saying zero: "nothing
 * changed" is a claim about a worktree that has not been read, which is the
 * same line the Changes list itself refuses to draw. A read that *failed* says
 * that instead — an empty strip would be the same lie in a quieter voice.
 */
function drawCodeStrip(): void {
  const parts = codeParts;
  if (!parts) return;

  const current = currentChangesView();
  parts.chips.textContent = '';

  if (current === null) {
    const failure = changesFailure();
    parts.count.textContent = failure ?? 'not read yet';
    parts.count.title = failure ?? '';
    parts.stat.textContent = '';
    parts.base.textContent = '';
    return;
  }
  parts.count.title = '';

  const { files, additions, deletions } = current.totals;
  parts.count.textContent = `${files} file${files === 1 ? '' : 's'}`;

  parts.stat.textContent = '';
  if (additions > 0) parts.stat.appendChild(span('fold-add', `+${additions}`));
  if (deletions > 0) parts.stat.appendChild(span('fold-del', `−${deletions}`));

  // The base git actually used, never the one that was asked for — invariant 7
  // holds on a one-line strip exactly as it does in the sidebar's header.
  parts.base.textContent = current.base.kind === 'uncommitted'
    ? 'uncommitted'
    : `vs ⎇ ${baseLabel(current.base)}`;

  const drawn = new Set<string>();
  for (const group of current.groups) {
    for (const row of group.rows) {
      // A file two sessions both touched has a row in both their groups; one
      // chip per *file* is what the strip is counting.
      if (drawn.has(row.path)) continue;
      drawn.add(row.path);
      parts.chips.appendChild(chipFor(row.path, statusTone(row.status)));
      // The row overflows rather than wraps, so past this nothing is reachable
      // anyway — and a 200-file diff would otherwise build 200 buttons nobody
      // can see. The sidebar's list is where the whole thing is read.
      if (drawn.size >= MAX_CHIPS) return;
    }
  }
}

function chipFor(path: string, tone: ReturnType<typeof statusTone>): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `fold-chip fold-chip-${tone}`;
  chip.dataset.path = path;
  chip.textContent = basename(path);
  chip.title = path;
  return chip;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

// ── the conversation half, folded ─────────────────────────────────────────────

function buildConversationStrip(handlers: FoldStripHandlers): HTMLElement {
  const strip = buildStrip('fold-strip-conversation', `Back to the session — ${shortcutLabel('J')}`, handlers.onExpand);

  const dot = span('fold-dot');
  const name = span('fold-name');
  const line = span('fold-line');
  strip.append(dot, name, line);

  closeStrip(strip);
  conversationParts = { dot, name, line };
  return strip;
}

function drawConversationStrip(): void {
  const parts = conversationParts;
  const sessionId = view.activeSessionId;
  if (!parts || sessionId === null) return;

  const badge = badgeFor([signalsFor(sessionId)]);
  parts.dot.className = 'fold-dot' + (badge === null ? '' : ` ${badge}`);

  const session = sessionMap.get(sessionId) ?? openSessions.get(sessionId)?.session;
  parts.name.textContent = session
    ? cleanDisplayName(session.name || session.aiTitle || session.summary) ?? sessionId
    : sessionId;

  parts.line.textContent = lastMessageLine(terminalTail(openSessions.get(sessionId)));
}

/**
 * The tail of a session's scrollback, oldest first.
 *
 * Read straight off the live xterm buffer, which is the point of never
 * unmounting it: the terminal the user flipped away from is the same object,
 * still holding everything it has been sent. `translateToString(true)` trims
 * the row's trailing blanks, so a mostly-empty screen does not read as content.
 */
function terminalTail(entry: OpenSession | undefined): string[] {
  if (!entry) return [];
  const buffer = entry.terminal.buffer.active;
  const end = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  for (let y = Math.max(0, end - TAIL_ROWS); y <= end; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
  }
  return lines;
}
