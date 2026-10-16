/**
 * Batching the terminal byte stream into as few `write()` calls as it needs.
 *
 * Its own module, apart from the xterm lifecycle in `terminal-manager`, so the
 * registry of held-back output loads in node and its re-key can be tested
 * there.
 */
import { openSessions, view } from '../../state/session-store';
import type { Terminal } from '@xterm/xterm';

/** Terminal output held back while a synchronised-update block is open. */
export interface WriteBuffer {
  chunks: string[];
  syncDepth: number;
  rafId: number;
  timerId: ReturnType<typeof setTimeout>;
}

// Check whether a terminal is scrolled to the bottom using xterm's buffer API.
export function isAtBottom(terminal: Terminal): boolean {
  const buf = terminal.buffer.active;
  return buf.viewportY >= buf.baseY;
}

export const ESC_SYNC_START = '\x1b[?2026h';
export const ESC_SYNC_END = '\x1b[?2026l';
export const SYNC_BUFFER_TIMEOUT = 500; // max ms to hold data waiting for sync end
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
 * Follow a re-key: the output held for the old id is the new id's now.
 *
 * Its pending flush was armed against the old id, and would look the buffer up
 * under an id nothing answers to any more — leaving the held chunks unwritten
 * until the next one arrived. So the timers are re-armed under the new id.
 * Runs after `openSessions` has moved, because the flush finds the terminal
 * there.
 */
export function rekeyWriteBuffer(oldId: string, newId: string): void {
  const buffer = terminalWriteBuffers.get(oldId);
  if (!buffer || oldId === newId) return;
  terminalWriteBuffers.delete(oldId);
  cancelAnimationFrame(buffer.rafId);
  clearTimeout(buffer.timerId);
  buffer.timerId = 0 as unknown as ReturnType<typeof setTimeout>;

  terminalWriteBuffers.set(newId, buffer);

  if (buffer.syncDepth > 0) {
    buffer.timerId = setTimeout(() => flushTerminalBuffer(newId), SYNC_BUFFER_TIMEOUT);
  } else {
    scheduleFlush(newId, buffer);
  }
}
