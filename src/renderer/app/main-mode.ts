/**
 * The flip: which half of the window the conversation and the code get.
 *
 * `⌘J` swaps them. The half you are not in never closes — it folds to a strip
 * along the bottom and keeps its scroll — so flipping back is instant and lands
 * exactly where you were. A `Talk | Split | Code` control in the terminal header
 * exposes the three states; ⌘J bounces the outer two, and choosing `Split`
 * makes it stay.
 *
 * **Two axes, not one.** `#file-panel` is created at runtime *inside*
 * `#terminal-area` by `initFilePanel()`, while `#code-area` is a sibling of
 * that area under `#main` and is registered with `viewers.ts` like any other
 * panel. A mode is therefore a pair of facts about two independent surfaces,
 * which is why it is not one more `PanelName` — `viewers.ts` stays a dumb
 * one-of-N and the pairing is owned here. The table is in `main-mode-model.ts`.
 *
 * **Nothing is unmounted to fold it.** No element is created or destroyed by a
 * mode change; only sizes and visibility move. The xterm instance either side of
 * a flip is the same object, which is what keeps the scrollback and avoids a
 * reflow of the whole session — and it is why `closeFilePanel` is used for the
 * split rather than the panel's own close button, which would answer a pending
 * diff on the user's behalf.
 *
 * **Per session.** A session you were reading stays on `code` while the one you
 * switch to stays wherever you left it, so the mode is stored under the session
 * id and re-applied whenever a session is shown.
 *
 * The terminal manager imports back into this module twice — for ⌘J, which has
 * to be caught inside xterm's own key handler or the shell receives a newline,
 * and for the re-apply at the end of `showSession`, which is the only point at
 * which a session is definitely the one on screen. Nothing here is used while
 * either module is still evaluating, so the loop is a call graph rather than an
 * initialisation order.
 */
import { closeFilePanel, openFilePanel } from '../features/panel/file-panel';
import { codeArea } from '../lib/dom';
import { installFoldStrips, renderFoldStrips } from '../features/code/fold-strip';
import { installModeControl, paintModeControl } from '../features/sessions/terminal-header';
import { openSessions, view } from '../state/session-store';
import { safeFit } from '../features/terminal/terminal-manager';
import { showTerminalArea } from './tab-router';
import { showViewer } from '../features/panel/viewers';
import { flipped, readSessionMode, surfacesFor, writeSessionMode } from './main-mode-model';
import type { MainMode } from './main-mode-model';
import type { OpenSession } from '../state/session-store';

export type { MainMode } from './main-mode-model';

/**
 * A listener, and the teardown it hands back.
 *
 * Effect-shaped rather than event-shaped: a listener that puts something on
 * screen for one mode usually has something to undo for the next, and returning
 * the undo is what keeps the two next to each other instead of in a second
 * handler that has to remember what the first did. The teardown runs before the
 * listener is called again, and once more when it unsubscribes.
 */
type MainModeListener = (mode: MainMode) => () => void;

const listeners = new Set<MainModeListener>();
const teardowns = new Map<MainModeListener, () => void>();

let installed = false;

/**
 * Applying a mode can put the terminal back, which restores the main area,
 * which shows the session, which asks for the mode to be applied. One guard
 * rather than a rule about who may call what: every path in is legitimate, and
 * the second one through is always redundant.
 */
let applying = false;

/** Where the terminal was scrolled to, captured before the sizes move. */
interface TerminalScroll {
  entry: OpenSession | undefined;
  /** xterm's scroll offset, and whether it was pinned to the newest output. */
  viewportY: number;
  atBottom: boolean;
}

/**
 * Where the code panel was scrolled to, kept across the whole fold.
 *
 * Not captured-and-restored in one pass like the terminal's, because the
 * browser tears down the layout box of a `display: none` element: `scrollTop`
 * reads 0 while the half is folded and cannot be written to it either. So the
 * offset is taken the last time the half was visible and put back the next time
 * it is — which is the fold keeping its scroll, and the only way to do it.
 *
 * The element is remembered alongside the number: opening a different file
 * rebuilds CodeMirror, and restoring the old file's offset into the new one
 * would drop the reader somewhere arbitrary in a document they just opened.
 */
let codeScroll: { scroller: HTMLElement; top: number } | null = null;

export function installMainMode(): void {
  if (installed) return;
  installed = true;

  installFoldStrips({
    onExpand: flipMainMode,
    onShowCode: () => setMainMode('code'),
  });
  installModeControl(setMainMode);

  applyMainMode();
}

/** The active session's mode, or `talk` when there is no session to flip. */
export function getMainMode(): MainMode {
  const sessionId = view.activeSessionId;
  return sessionId === null ? 'talk' : readSessionMode(sessionId);
}

/**
 * Put the window in one mode, and remember it for this session.
 *
 * A no-op with no active session: there is nothing to remember it against, and
 * nothing to fold — the main area is showing the placeholder.
 */
export function setMainMode(mode: MainMode): void {
  const sessionId = view.activeSessionId;
  if (sessionId === null) return;
  writeSessionMode(sessionId, mode);
  applyMainMode();
}

/** ⌘J. Bounces `talk` and `code`; from `split`, goes to `code`. */
export function flipMainMode(): void {
  setMainMode(flipped(getMainMode()));
}

/**
 * Be told when the mode changes, and hand back the undo.
 *
 * Also called once per application even when the mode has not moved: a session
 * switch re-applies whatever the new session was left in, and a listener that
 * paints the current mode has to repaint for it.
 */
export function onMainModeChange(fn: (m: MainMode) => () => void): () => void {
  listeners.add(fn);
  return () => {
    runTeardown(fn);
    listeners.delete(fn);
  };
}

/**
 * Put the surfaces where the active session's mode wants them.
 *
 * Called by every path that changes the mode, and by `showSession` — which
 * hides the panels on its way to the terminal, so a session left on `code` has
 * to be put back afterwards rather than before.
 */
export function applyMainMode(): void {
  if (!installed || applying) return;
  applying = true;
  try {
    const mode = getMainMode();
    const want = surfacesFor(mode);
    const scroll = rememberScroll();

    // The code half. `showTerminalArea` is the one measured path back out of a
    // panel; the guard is the code area's own — another viewer may have taken
    // the main area, and restoring the terminal from under it would be a
    // surprise the flip has no business causing.
    if (want.code) showViewer('code');
    else if (codeArea.style.display !== 'none') showTerminalArea();

    // The split half, inside the terminal area. Collapsed rather than closed:
    // whatever the CLI put in it is still there and still unanswered.
    if (want.filePanel) openFilePanel();
    else closeFilePanel();

    // The mode as it now reads: the folded half's strip, and the control that
    // names all three. Both are part of putting the mode on screen, so both
    // happen here rather than through the listener seam below — which exists
    // for whatever wants to know *later*, not for the flip's own chrome.
    renderFoldStrips(mode);
    paintModeControl(mode);

    restoreScroll(scroll, want.terminal);
    notify(mode);
  } finally {
    applying = false;
  }
}

// ── listeners ─────────────────────────────────────────────────────────────────

function notify(mode: MainMode): void {
  for (const fn of [...listeners]) {
    runTeardown(fn);
    try {
      teardowns.set(fn, fn(mode));
    } catch (err) {
      // One listener that throws must not leave the rest on the previous mode.
      console.error('main mode listener failed', err);
    }
  }
}

function runTeardown(fn: MainModeListener): void {
  const teardown = teardowns.get(fn);
  if (!teardown) return;
  teardowns.delete(fn);
  try {
    teardown();
  } catch (err) {
    console.error('main mode teardown failed', err);
  }
}

// ── keeping both halves where they were ───────────────────────────────────────

/**
 * Read both halves' scroll positions before anything moves.
 *
 * The terminal keeps its buffer across a hide, but a resize moves the viewport
 * within it, so the offset is restored rather than assumed. The code panel's is
 * only readable while that half is up, which is exactly now.
 */
function rememberScroll(): TerminalScroll {
  const scroller = codeScroller();
  if (scroller && codeArea.style.display !== 'none') {
    codeScroll = { scroller, top: scroller.scrollTop };
  }

  const entry = activeEntry();
  const buffer = entry?.terminal.buffer.active;
  return {
    entry,
    viewportY: buffer?.viewportY ?? 0,
    atBottom: buffer === undefined || buffer.viewportY >= buffer.baseY,
  };
}

/**
 * Refit, then put both halves back where they were.
 *
 * Deferred a frame, like every other refit in the renderer: xterm measures its
 * grid in pixels and cannot measure a hidden element, and the strip that just
 * appeared only has its height once the browser has laid it out. Nothing here
 * animates its height, so one frame is enough — the sizes are final by then
 * rather than part-way through a transition.
 */
function restoreScroll(saved: TerminalScroll, terminalVisible: boolean): void {
  requestAnimationFrame(() => {
    const { entry } = saved;
    if (entry && terminalVisible && !view.gridViewActive) {
      safeFit(entry);
      if (saved.atBottom) entry.terminal.scrollToBottom();
      else entry.terminal.scrollLines(saved.viewportY - entry.terminal.buffer.active.viewportY);
    }

    const scroller = codeScroller();
    if (!terminalVisible && scroller && codeScroll?.scroller === scroller) {
      scroller.scrollTop = codeScroll.top;
    }
  });
}

function activeEntry(): OpenSession | undefined {
  const sessionId = view.activeSessionId;
  const entry = sessionId === null ? undefined : openSessions.get(sessionId);
  return entry?.closed ? undefined : entry;
}

/** CodeMirror's own scrolling element, absent until a file has been opened. */
function codeScroller(): HTMLElement | null {
  return codeArea.querySelector<HTMLElement>('.cm-scroller');
}
