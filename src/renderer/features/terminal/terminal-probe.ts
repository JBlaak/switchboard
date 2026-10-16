/**
 * A read-mostly window onto the open terminals, for the e2e suite only.
 *
 * xterm draws on a canvas, so a test cannot read what a terminal shows, where
 * it is scrolled to or how it was built from the DOM. This answers those
 * questions from the xterm instances themselves. It is installed only when the
 * preload says the harness launched the app (`window.switchboardE2E`), so a
 * normal run never has it.
 *
 * Everything goes through `openSessions`, the registry the terminal manager
 * keeps, so the probe does not care how the terminals are put on screen.
 */
import { openSessions } from '../../state/session-store';
import type { OpenSession } from '../../state/session-store';

/** What a test can learn about one terminal. */
export interface TerminalProbeState {
  cols: number;
  rows: number;
  /** The first buffer line in view. */
  viewportY: number;
  /** The first buffer line of the bottom page; `viewportY === baseY` is "at the bottom". */
  baseY: number;
  scrollback: number | undefined;
  convertEol: boolean | undefined;
  macOptionClickForcesSelection: boolean | undefined;
  hasLinkHandler: boolean;
  unicodeVersion: string;
  background: string | undefined;
  /** Which renderer drew the last frame: the WebGL addon's canvas, or xterm's DOM rows. */
  renderer: 'webgl' | 'dom';
  selection: string;
  /** Where the selection starts in the buffer (a search match is a selection), or null. */
  selectionStart: { x: number; y: number } | null;
  /** The size of one cell in CSS pixels, and where the grid starts on the page. */
  cell: { width: number; height: number; left: number; top: number };
  /** Whether the terminal's container is the one on screen. */
  visible: boolean;
  /** Whether a drag is over the terminal (its drop highlight is on). */
  dragOver: boolean;
  closed: boolean;
}

export interface TerminalProbe {
  sessionIds(): string[];
  /** The whole buffer, scrollback included, one string per line, trailing blanks trimmed. */
  lines(sessionId: string): string[] | null;
  state(sessionId: string): TerminalProbeState | null;
  scrollLines(sessionId: string, amount: number): void;
  select(sessionId: string, column: number, row: number, length: number): void;
}

declare global {
  interface Window {
    __switchboardTerminals?: TerminalProbe;
  }
}

export function installTerminalProbe(): void {
  if (!window.switchboardE2E) return;
  window.__switchboardTerminals = {
    sessionIds: () => [...openSessions.keys()],
    lines: (sessionId) => withEntry(sessionId, readLines),
    state: (sessionId) => withEntry(sessionId, readState),
    scrollLines: (sessionId, amount) => { openSessions.get(sessionId)?.terminal.scrollLines(amount); },
    select: (sessionId, column, row, length) => { openSessions.get(sessionId)?.terminal.select(column, row, length); },
  };
}

function withEntry<T>(sessionId: string, read: (entry: OpenSession) => T): T | null {
  const entry = openSessions.get(sessionId);
  return entry ? read(entry) : null;
}

function readLines({ terminal }: OpenSession): string[] {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  return lines;
}

function readState({ terminal, element, closed }: OpenSession): TerminalProbeState {
  const buffer = terminal.buffer.active;
  const screen = element.querySelector<HTMLElement>('.xterm-screen');
  const box = screen?.getBoundingClientRect();
  const { options } = terminal;
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    scrollback: options.scrollback,
    convertEol: options.convertEol,
    macOptionClickForcesSelection: options.macOptionClickForcesSelection,
    hasLinkHandler: !!options.linkHandler,
    unicodeVersion: terminal.unicode.activeVersion,
    background: options.theme?.background,
    renderer: element.querySelector('.xterm-rows') ? 'dom' : 'webgl',
    selection: terminal.getSelection(),
    selectionStart: terminal.getSelectionPosition()?.start ?? null,
    cell: {
      width: box ? box.width / terminal.cols : 0,
      height: box ? box.height / terminal.rows : 0,
      left: box?.left ?? 0,
      top: box?.top ?? 0,
    },
    visible: element.classList.contains('visible'),
    dragOver: element.classList.contains('drag-over'),
    closed: !!closed,
  };
}
