// --- Terminal management ---
// Key bindings, xterm instance lifecycle, drag-and-drop. The write buffering
// the byte stream goes through is in `write-buffer`.
//
// React decides which terminals have a container and which one is on screen
// (`ui/terminal/TerminalHost`); this module builds each xterm, opens it into
// the container React gives it, and owns everything that happens inside.
//
import {
  DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_LINE_HEIGHT,
  decodeOsc52Payload, enterKittySequence, normalizeTerminalFont, shouldSendSpaceDirectly,
} from '../terminal/terminal-input';
import type { StoredFontSettings } from '../terminal/terminal-input';
import type { OpenSession } from '../../state/session-store';
import type { SessionRow } from '../../../domain/session/session';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import { flushSync } from 'react-dom';
import { clearNotifications } from '../../state/activity-store';
import { dispatch } from '../../state/app-store';
import { setActiveSession } from '../sessions/active-session';
import { headerNameFor } from '../sessions/terminal-header';
import { loadShellProfile } from '../../ui/terminal/actions';
import { placeholder, settingsViewer, terminalArea } from '../../lib/dom';
import { handleSessionNavKey, isSessionNavKey } from '../terminal/session-nav';
import {
  archiveActiveSession, focusSidebar, isArchiveSessionKey, isSessionPickerKey, isSidebarFocusKey,
} from '../sessions/sidebar-keyboard';
import { openDialog } from '../../ui/dialogs/actions';
import { isQuickSessionKey, launchQuickSession } from '../sessions/quick-session';
import { isSessionWorkKey, toggleSessionWork } from '../../ui/session-work/actions';
import { openSessions, sessionMap } from '../../state/session-store';
import { remoteStatus } from '../../state/remote-status-store';
import { TERMINAL_THEME } from '../terminal/terminal-themes';
import { isAtBottom } from './write-buffer';
import { posixQuote } from '../../../domain/shell/quoting';

// --- Terminal font ---
// Global font settings shared by every xterm instance. Mutated by applyTerminalFont
// when the user saves global settings (or on startup, from the stored settings).

const TERMINAL_FONT = {
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
  lineHeight: DEFAULT_TERMINAL_LINE_HEIGHT,
};

// Whether a font family actually resolves to an installed font. There is no API that
// answers this directly, so compare rendered metrics against a deliberately bogus
// family: if the two match, the browser fell back rather than finding the font.
// Used only to warn in settings — rendering itself is safe via withMonospaceFallback.
export function isFontAvailable(family: string): boolean {
  if (typeof document === 'undefined') return true;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return true;
  const measure = (f: string) => { ctx.font = '72px ' + f; return ctx.measureText('MWil@1%').width; };
  const missing = '__switchboard_no_such_font__';
  return measure(family + ', ' + missing) !== measure(missing);
}

// Refit every open terminal. A terminal with no layout box (hidden behind the settings
// viewer, or inactive in single view) cannot measure itself — proposeDimensions returns
// nothing and the fit is silently skipped — so this must be called again once the
// terminals have size, or they keep stale cols/rows and their output runs off-screen.
export function refitOpenTerminals() {
  for (const [, entry] of openSessions) fitAndScroll(entry);
}

// Apply font settings to new terminals and re-render every open one. Changing font
// metrics changes how many cols/rows fit, so each terminal is refitted (which resizes
// its PTY through the onResize handler).
export function applyTerminalFont(font?: StoredFontSettings): void {
  Object.assign(TERMINAL_FONT, normalizeTerminalFont(font));
  for (const [, entry] of openSessions) {
    entry.terminal.options.fontFamily = TERMINAL_FONT.fontFamily;
    entry.terminal.options.fontSize = TERMINAL_FONT.fontSize;
    entry.terminal.options.lineHeight = TERMINAL_FONT.lineHeight;
  }
  refitOpenTerminals();
}

// --- Terminal key bindings ---
// Modified Enter → kitty protocol CSI-u sequences that Claude Code recognizes:
//   Shift+Enter → CSI 13;2u — insert a newline instead of submitting.
//   Ctrl+Enter  → CSI 13;5u — "send now" (flush a queued message mid-turn).
// A terminal can't otherwise distinguish these from a plain Enter (all bare \r), so
// xterm never emits them; we synthesize the kitty encoding. See enterKittySequence.
// Two layers needed:
//   1. attachCustomKeyEventHandler returning false — blocks xterm's key pipeline (onKey/onData)
//   2. preventDefault on capture-phase keydown — prevents browser inserting \n into textarea
/** A keydown this module has already acted on, flagged for the capture listener. */
interface HandledKeyboardEvent extends KeyboardEvent {
  _handled?: boolean;
}

function setupTerminalKeyBindings(
  terminal: Terminal,
  container: HTMLElement,
  getSessionId: () => string | null,
  { onFind }: { onFind?: () => void } = {},
): void {
  terminal.attachCustomKeyEventHandler((e: HandledKeyboardEvent) => {
    // Cmd+F → open terminal search bar
    if (e.key === 'f' && e.metaKey && !e.shiftKey && !e.altKey) {
      if (e.type === 'keydown' && onFind) onFind();
      return false;
    }

    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    if (isSessionNavKey(e)) {
      if (e.type === 'keydown') { e._handled = true; handleSessionNavKey(e); }
      return false;
    }

    // Cmd+L: hand the keyboard to the session list
    if (isSidebarFocusKey(e)) {
      if (e.type === 'keydown') { e._handled = true; focusSidebar(); }
      return false;
    }

    // Cmd+A: open the new-session picker. preventDefault keeps the menu's
    // Select All from also running.
    if (isSessionPickerKey(e)) {
      if (e.type === 'keydown') { e._handled = true; e.preventDefault(); openDialog({ kind: 'projectPicker' }); }
      return false;
    }

    // Cmd+E: archive this session
    if (isArchiveSessionKey(e)) {
      if (e.type === 'keydown') { e._handled = true; archiveActiveSession(); }
      return false;
    }

    // Cmd+G: the Session work page, in this terminal's place
    if (isSessionWorkKey(e)) {
      if (e.type === 'keydown') { e._handled = true; e.preventDefault(); void toggleSessionWork(); }
      return false;
    }

    // Cmd+N: start a quick session
    if (isQuickSessionKey(e)) {
      if (e.type === 'keydown') { e._handled = true; void launchQuickSession(); }
      return false;
    }

    // Shift+Enter → newline, Ctrl+Enter → "send now" (kitty CSI-u). See enterKittySequence.
    const enterSeq = enterKittySequence(e);
    if (enterSeq) {
      if (e.type === 'keydown') {
        const sid = getSessionId();
        if (sid) window.api.sendInput(sid, enterSeq);
      }
      return false;
    }

    // Space → send directly on keydown (including key-repeat) to ensure reliable
    // delivery to the PTY. xterm.js's evaluateKeyboardEvent does not handle plain
    // Space in keydown (keyCode 32 < 48 threshold) and instead relies on the
    // deprecated 'keypress' event, which Electron/Chromium may not fire reliably
    // for key-repeat events. This fixes Claude Code's "Hold Space to record"
    // push-to-talk voice feature, which depends on rapid key-repeat characters
    // arriving at stdin to detect a held key.
    // Skips IME composition (isImeComposing): during Korean/Japanese/Chinese
    // composition, Space commits the pending syllable, so it must fall through
    // to xterm's composition helper instead of being sent raw.
    if (shouldSendSpaceDirectly(e)) {
      if (e.type === 'keydown') {
        e.preventDefault();
        {
          const sid = getSessionId();
          if (sid) window.api.sendInput(sid, ' ');
        }
      }
      return false;
    }

    return true;
  });

  const textarea = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  if (textarea) {
    textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      // Suppress the browser's literal \n for ANY Ctrl/Shift-modified Enter — a superset
      // of what enterKittySequence translates. This deliberately also covers
      // Ctrl+Shift+Enter (which we don't translate): without it the browser would insert
      // a stray \n into the hidden helper textarea for that combo.
      if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey) && !e.altKey && !e.metaKey) {
        e.preventDefault();
      }
    }, { capture: true });
  }
}

// Fit terminal to container, subtracting 1 row to avoid partial-row clipping.
export function safeFit(entry: OpenSession): void {
  const dims = entry.fitAddon.proposeDimensions();
  if (dims && dims.rows > 1) {
    entry.terminal.resize(dims.cols, dims.rows);
  } else {
    entry.fitAddon.fit();
  }
}

// Fit a terminal that just became visible (from display:none or reparent).
// Defers to requestAnimationFrame so the container has dimensions.
export function fitAndScroll(entry: OpenSession): void {
  const wasAtBottom = isAtBottom(entry.terminal);
  requestAnimationFrame(() => {
    safeFit(entry);
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    }
  });
}

/** How long after boot the throwaway warm-up terminal is built. */
const PREWARM_DELAY_MS = 100;

/**
 * Build and throw away one xterm instance at startup.
 *
 * The first terminal opened pays for compiling the WebGL renderer and measuring
 * the font, which is long enough to see. Doing it off-screen before the user
 * clicks anything moves that cost somewhere nobody is waiting.
 */
export function prewarmTerminalRenderer(): void {
  setTimeout(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;width:400px;height:200px;';
    document.body.appendChild(host);

    const terminal = new Terminal({ cols: 80, rows: 10 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminal.write(' ');

    requestAnimationFrame(() => {
      terminal.dispose();
      host.remove();
    });
  }, PREWARM_DELAY_MS);
}

// --- Terminal lifecycle helpers ---

/** The next container key; see `TerminalSlot` in `state/terminal-slice`. */
let nextSlotId = 1;

/**
 * Create a session's xterm, wire it to IPC and register it in openSessions.
 *
 * The xterm is opened into the container React renders for the session, and
 * that render happens right here (`flushSync`), so the entry comes back with
 * its element, as it did when this built the container itself. That needs a
 * caller outside React's own work — an event handler or a promise callback,
 * which every caller is; from inside a store listener or a React render the
 * container would only mount a moment later.
 *
 * Does NOT make it visible or fit it — call showSession() for that.
 */
export function createTerminalEntry(session: SessionRow): OpenSession {
  const { sessionId } = session;

  const terminal = new Terminal({
    fontSize: TERMINAL_FONT.fontSize,
    fontFamily: TERMINAL_FONT.fontFamily,
    lineHeight: TERMINAL_FONT.lineHeight,
    theme: TERMINAL_THEME,
    cursorBlink: false,
    scrollback: 10000,
    convertEol: true,
    allowProposedApi: true,
    // A TUI that turns on full mouse tracking (CSI ?1003h) makes xterm forward every
    // drag to the application, so normal text selection is dead. Terminal.app and
    // iTerm2 let you hold Option to override that; xterm.js requires opting in.
    // Without this, selecting (and therefore copying) inside such a session is
    // impossible on macOS and Cmd+C silently leaves the previous clipboard contents
    // in place.
    macOptionClickForcesSelection: true,
    linkHandler: {
      activate: (_event, uri) => {
        window.api.openExternal(uri);
      },
      allowNonHttpProtocols: true,
    },
  });

  // OSC 52 — let the program inside the terminal set the system clipboard (this is how
  // Claude Code copies). xterm doesn't wire this up itself, so we do.
  // Routed through the main process — see writeClipboard.
  terminal.parser.registerOscHandler(52, (payload) => {
    let text;
    try {
      text = decodeOsc52Payload(payload);
    } catch {
      return false;
    }
    // null = read-back query or empty payload: consumed, and deliberately not
    // answered. See decodeOsc52Payload.
    if (text === null) return true;
    window.api.writeClipboard(text).catch(() => {});
    return true;
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon((_event, url) => {
    window.api.openExternal(url);
  }));
  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';

  // `element` is filled in by attachTerminal, when the container mounts below.
  const entry: OpenSession = {
    terminal, element: undefined as unknown as HTMLElement, fitAddon, searchAddon, session, closed: false,
  };
  openSessions.set(sessionId, entry);

  // Wire up IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(entry.session.sessionId, data);
  });
  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(entry.session.sessionId, cols, rows);
  });
  terminal.onTitleChange(title => {
    dispatch({ type: 'ptyTitleChanged', sessionId: entry.session.sessionId, title });
  });

  flushSync(() => dispatch({ type: 'terminalOpened', sessionId, slotId: nextSlotId++ }));
  return entry;
}

/**
 * Open a session's xterm into the container React rendered for it.
 *
 * Called from the container's ref, so the container is in the document: xterm
 * measures its font on open, and the WebGL addon needs an attached canvas.
 * Idempotent — StrictMode calls a ref twice in development.
 */
export function attachTerminal(sessionId: string, container: HTMLElement): void {
  const entry = openSessions.get(sessionId);
  if (!entry || entry.element) return;
  entry.element = container;
  const { terminal } = entry;

  terminal.open(container);
  container.style.backgroundColor = TERMINAL_THEME.background;

  // GPU-accelerated rendering via WebGL — drops renderer+compositor CPU ~50-70%.
  // Must be loaded after terminal.open() (needs attached DOM). Fails silently on
  // machines without WebGL support; xterm falls back to the default DOM renderer.
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    terminal.loadAddon(webglAddon);
  } catch (e) {
    console.warn('[terminal] WebGL addon failed, falling back to DOM renderer', e);
  }

  // Cmd+F asks the store; the search bar in this container answers it.
  const onFind = () => dispatch({ type: 'terminalSearchOpened', sessionId: entry.session.sessionId });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId, { onFind });
  setupDragAndDrop(container, () => entry.session.sessionId);
}

// Clean up a closed session entry (dispose terminal, remove DOM, remove from maps).
export function destroySession(sessionId: string): void {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  window.api.closeTerminal(sessionId);
  // Drop the remote-connection state; the connecting card goes with the element.
  if (typeof remoteStatus !== 'undefined') remoteStatus.delete(sessionId);
  entry.terminal.dispose();
  openSessions.delete(sessionId);
  // React removes the container; now, like the rest of the teardown.
  flushSync(() => dispatch({ type: 'terminalClosed', sessionId }));
}

// Make a session visible.
// Handles sidebar highlight, notifications, header, fit, and focus.
export function showSession(sessionId: string): void {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);

  // React puts the session's container and header on screen, and highlights its
  // row in the sidebar. Rendered now: the terminal cannot take focus or measure
  // itself until it is displayed.
  flushSync(() => {
    setActiveSession(sessionId);
    dispatch({ type: 'sessionShown', sessionId, name: session ? headerNameFor(session) : '' });
  });
  clearNotifications(sessionId);

  // Terminals and the settings panel share the main area, and only one may be
  // visible: putting the terminal back hides settings, so it cannot linger
  // behind it.
  placeholder.style.display = 'none';
  settingsViewer.style.display = 'none';
  dispatch({ type: 'settingsClosed' });
  terminalArea.style.display = '';
  if (session) void loadShellProfile(session);
  if (entry) {
    entry.terminal.focus();
    fitAndScroll(entry);
  }
}

function setupDragAndDrop(container: HTMLElement, getSessionId: () => string | null): void {
  let dragCounter = 0;
  container.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    container.classList.add('drag-over');
  });
  container.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      container.classList.remove('drag-over');
    }
  });
  container.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    container.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    const paths = Array.from(files).map(f => posixQuote(window.api.getPathForFile(f)));
    const sid = getSessionId();
    if (sid) window.api.sendInput(sid, paths.join(' '));
  });
}

