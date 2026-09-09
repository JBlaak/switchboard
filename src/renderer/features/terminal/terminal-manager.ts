// --- Terminal management ---
// Key bindings, write buffering, xterm instance lifecycle, drag-and-drop.
//
import {
  DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_LINE_HEIGHT,
  decodeOsc52Payload, normalizeTerminalFont, shouldSendSpaceDirectly,
} from '../terminal/terminal-input';
import type { StoredFontSettings } from '../terminal/terminal-input';
import type { OpenSession } from '../../state/session-store';
import type { SessionRow } from '../../../domain/session/session';

/** Terminal output held back while a synchronised-update block is open. */
export interface WriteBuffer {
  chunks: string[];
  syncDepth: number;
  rafId: number;
  timerId: ReturnType<typeof setTimeout>;
}
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import { clearNotifications } from '../../state/activity-store';
import { setActiveSession } from '../sessions/active-session';
import { showTerminalHeader, updatePtyTitle } from '../sessions/terminal-header';
import { gridViewerCount, placeholder, terminalsEl } from '../../lib/dom';
import { openFileInPanel } from '../panel/file-panel';
import { focusGridCard, gridCards, handleSessionNavKey, isSessionNavKey, showGridView, toggleGridView, wrapInGridCard } from '../terminal/grid-view';
import { hideAllViewers } from '../panel/viewers';
import { openSessions, sessionMap, view } from '../../state/session-store';
import { remoteStatus } from '../../state/remote-status-store';
import { TERMINAL_THEME } from '../terminal/terminal-themes';
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
// Shift+Enter → kitty protocol (CSI 13;2u) so Claude Code treats it as newline, not submit.
// Two layers needed:
//   1. attachCustomKeyEventHandler returning false — blocks xterm's key pipeline (onKey/onData)
//   2. preventDefault on capture-phase keydown — prevents browser inserting \n into textarea
export const isMac = typeof window !== 'undefined' && window.api && window.api.platform === 'darwin';

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
    // Cmd/Ctrl+F → open terminal search bar
    if (e.key === 'f' && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (e.type === 'keydown' && onFind) onFind();
      return false;
    }

    // Cmd/Ctrl+Shift+G → toggle grid view
    if (e.key === 'g' && (isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey) {
      if (e.type === 'keydown') { e._handled = true; toggleGridView(); }
      return false;
    }

    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    if (isSessionNavKey(e)) {
      if (e.type === 'keydown') { e._handled = true; handleSessionNavKey(e); }
      return false;
    }

    // Shift+Enter → newline (kitty protocol CSI 13;2u) so Claude Code treats it as newline, not submit.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        {
          const sid = getSessionId();
          if (sid) window.api.sendInput(sid, '\x1b[13;2u');
        }
      }
      return false;
    }

    // Ctrl+Enter → newline on Windows/Linux (matches PowerShell convention).
    // Send the same Shift+Enter kitty sequence that Claude Code recognizes as newline.
    if (!isMac && e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        {
          const sid = getSessionId();
          if (sid) window.api.sendInput(sid, '\x1b[13;2u');
        }
      }
      return false;
    }

    // On Windows/Linux, Ctrl+V is captured by xterm as a control character (0x16)
    // instead of triggering a paste. Return false to block xterm's key pipeline and
    // let Electron's Edit menu { role: 'paste' } handle the actual clipboard paste.
    if (!isMac && e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      return false;
    }

    // On Windows/Linux, Ctrl+C with a selection should copy instead of sending SIGINT.
    // When nothing is selected, Ctrl+C falls through to xterm (sends SIGINT as normal).
    if (!isMac && e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (terminal.hasSelection()) {
        if (e.type === 'keydown') {
          window.api.writeClipboard(terminal.getSelection());
        }
        return false;
      }
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
      if (e.key === 'Enter' && (e.shiftKey || (!isMac && e.ctrlKey)) && !e.altKey && !e.metaKey) {
        e.preventDefault();
      }
    }, { capture: true });
  }
}

// Check whether a terminal is scrolled to the bottom using xterm's buffer API.
function isAtBottom(terminal: Terminal): boolean {
  const buf = terminal.buffer.active;
  return buf.viewportY >= buf.baseY;
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

// --- Terminal write buffering ---
// Batch incoming terminal data to coalesce IPC chunks into fewer write() calls.
export const ESC_SYNC_START = '\x1b[?2026h';
export const ESC_SYNC_END = '\x1b[?2026l';
export const SYNC_BUFFER_TIMEOUT = 500; // max ms to hold data waiting for sync end
/** How long after boot the throwaway warm-up terminal is built. */
const PREWARM_DELAY_MS = 100;
/** sessionId → the chunks held back while a synchronised-update block is open. */
export const terminalWriteBuffers = new Map<string, WriteBuffer>();

export function flushTerminalBuffer(sessionId: string): void {
  const buf = terminalWriteBuffers.get(sessionId);
  if (!buf) return;
  clearTimeout(buf.timerId);
  cancelAnimationFrame(buf.rafId);
  terminalWriteBuffers.delete(sessionId);

  const entry = openSessions.get(sessionId);
  if (!entry) return;

  const data = buf.chunks.join('');
  const wasAtBottom = isAtBottom(entry.terminal);
  const savedViewportY = entry.terminal.buffer.active.viewportY;
  entry.terminal.write(data, () => {
    if (sessionId !== view.activeSessionId) return;
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    } else {
      // Restore scroll position so redraws don't yank the user away
      entry.terminal.scrollLines(savedViewportY - entry.terminal.buffer.active.viewportY);
    }
  });
}

export function scheduleFlush(sessionId: string, buf: WriteBuffer): void {
  cancelAnimationFrame(buf.rafId);
  buf.rafId = requestAnimationFrame(() => flushTerminalBuffer(sessionId));
}

/**
 * Take a chunk of PTY output and decide when to write it.
 *
 * A TUI wraps a repaint in a synchronised-update block, and writing the halves
 * of one separately is what makes a redraw visibly tear. So a chunk that opens
 * a block is held until the block closes — with a timeout behind it, because a
 * process killed mid-repaint never closes its block and the data must not be
 * held forever.
 *
 * Outside a block, chunks are coalesced to one write per frame: the IPC stream
 * arrives in far smaller pieces than a frame needs.
 */
export function bufferTerminalData(sessionId: string, data: string): void {
  if (!openSessions.has(sessionId)) return;

  let buffer = terminalWriteBuffers.get(sessionId);
  if (!buffer) {
    buffer = { chunks: [], syncDepth: 0, rafId: 0, timerId: 0 as unknown as ReturnType<typeof setTimeout> };
    terminalWriteBuffers.set(sessionId, buffer);
  }
  buffer.chunks.push(data);

  // Blocks nest, so the depth is tracked rather than a flag.
  if (data.includes(ESC_SYNC_START)) buffer.syncDepth++;
  if (data.includes(ESC_SYNC_END)) buffer.syncDepth = Math.max(0, buffer.syncDepth - 1);

  if (buffer.syncDepth > 0) {
    cancelAnimationFrame(buffer.rafId);
    if (!buffer.timerId) {
      buffer.timerId = setTimeout(() => flushTerminalBuffer(sessionId), SYNC_BUFFER_TIMEOUT);
    }
    return;
  }

  clearTimeout(buffer.timerId);
  buffer.timerId = 0 as unknown as ReturnType<typeof setTimeout>;
  scheduleFlush(sessionId, buffer);
}

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

// Create an xterm instance, wire up IPC, and register in openSessions.
// Returns the entry. Does NOT make it visible or fit it — call showSession() for that.
export function createTerminalEntry(session: SessionRow): OpenSession {
  const { sessionId } = session;
  const container = document.createElement('div');
  container.className = 'terminal-container';
  terminalsEl.appendChild(container);

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
    // in place. Windows/Linux get the same escape hatch via Shift, which needs no flag.
    macOptionClickForcesSelection: true,
    linkHandler: {
      activate: (_event, uri) => {
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          try { openFileInPanel(sessionId, decodeURIComponent(new URL(uri).pathname)); } catch {}
        } else {
          window.api.openExternal(uri);
        }
      },
      allowNonHttpProtocols: true,
    },
  });

  // OSC 52 — let the program inside the terminal set the system clipboard (this is how
  // Claude Code copies). xterm doesn't wire this up itself, so we do.
  // Route through the main process — see writeClipboard — because the renderer clipboard
  // is unreliable on Wayland.
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
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      try { openFileInPanel(sessionId, decodeURIComponent(new URL(url).pathname)); } catch {}
    } else {
      window.api.openExternal(url);
    }
  }));
  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';
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

  // --- Terminal search bar (Cmd/Ctrl+F) ---
  const searchBar = document.createElement('div');
  searchBar.className = 'terminal-search-bar';
  searchBar.style.display = 'none';
  searchBar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="terminal-search-next" title="Next (Enter)">&#x25BC;</button>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  container.appendChild(searchBar);
  // Markup this function just wrote, so neither lookup can miss.
  const searchInput = searchBar.querySelector<HTMLElement>('.terminal-search-input') as HTMLInputElement;
  const searchCount = searchBar.querySelector<HTMLElement>('.terminal-search-count') as HTMLElement;
  const searchOpts = { decorations: { matchBackground: '#515C6A', activeMatchBackground: '#EAA549', matchOverviewRuler: '#515C6A', activeMatchColorOverviewRuler: '#EAA549' } };

  function openSearchBar() {
    searchBar.style.display = 'flex';
    searchInput.focus();
    const sel = terminal.getSelection();
    if (sel) { searchInput.value = sel; searchAddon.findNext(sel, searchOpts); }
  }
  function closeSearchBar() {
    searchBar.style.display = 'none';
    searchAddon.clearDecorations();
    searchInput.value = '';
    searchCount.textContent = '';
    terminal.focus();
  }
  searchInput.addEventListener('input', () => {
    const q = searchInput.value;
    if (q) { searchAddon.findNext(q, searchOpts); } else { searchAddon.clearDecorations(); searchCount.textContent = ''; }
  });
  searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeSearchBar(); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { searchAddon.findPrevious(searchInput.value, searchOpts); e.preventDefault(); }
    else if (e.key === 'Enter') { searchAddon.findNext(searchInput.value, searchOpts); e.preventDefault(); }
  });
  (searchBar.querySelector<HTMLElement>('.terminal-search-next') as HTMLElement).addEventListener('click', () => searchAddon.findNext(searchInput.value, searchOpts));
  (searchBar.querySelector<HTMLElement>('.terminal-search-prev') as HTMLElement).addEventListener('click', () => searchAddon.findPrevious(searchInput.value, searchOpts));
  (searchBar.querySelector<HTMLElement>('.terminal-search-close') as HTMLElement).addEventListener('click', closeSearchBar);

  const entry: OpenSession = { terminal, element: container, fitAddon, searchAddon, openSearchBar, closeSearchBar, session, closed: false };
  openSessions.set(sessionId, entry);

  // Wire up IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(entry.session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId, { onFind: openSearchBar });
  setupDragAndDrop(container, () => entry.session.sessionId);
  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(entry.session.sessionId, cols, rows);
  });
  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (view.activeSessionId === entry.session.sessionId) updatePtyTitle();
  });
  return entry;
}

// Clean up a closed session entry (dispose terminal, remove DOM, remove from maps).
export function destroySession(sessionId: string): void {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  window.api.closeTerminal(sessionId);
  // Drop the remote-connection state; the connecting card goes with the element.
  if (typeof remoteStatus !== 'undefined') remoteStatus.delete(sessionId);
  entry.terminal.dispose();
  entry.element.remove();
  openSessions.delete(sessionId);
  const card = gridCards.get(sessionId);
  if (card) { card.remove(); gridCards.delete(sessionId); }
}

// Make a session visible in the current view mode (grid or single).
// Handles sidebar highlight, notifications, header, fit, and focus.
export function showSession(sessionId: string): void {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);

  // Update sidebar active state
  document.querySelectorAll<HTMLElement>('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');
  setActiveSession(sessionId);
  clearNotifications(sessionId);

  if (view.gridViewActive) {
    // Ensure grid layout is set up (e.g. on first session after startup restore)
    if (!terminalsEl.classList.contains('grid-layout')) {
      showGridView();
    }
    if (entry && gridCards.has(sessionId)) {
      // Already in grid — just focus it
      focusGridCard(sessionId);
    } else if (entry) {
      // New entry not yet in grid — wrap and focus
      wrapInGridCard(sessionId);
      fitAndScroll(entry);
      requestAnimationFrame(() => focusGridCard(sessionId));
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    }
  } else {
    // Single terminal view
    document.querySelectorAll<HTMLElement>('.terminal-container').forEach(el => el.classList.remove('visible'));
    placeholder.style.display = 'none';
    hideAllViewers();
    if (session) showTerminalHeader(session);
    if (entry) {
      entry.element.classList.add('visible');
      entry.terminal.focus();
      fitAndScroll(entry);
    }
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

