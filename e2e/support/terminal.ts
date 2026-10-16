/**
 * Reading a terminal from a test.
 *
 * xterm draws on a canvas, so its text, scroll position and options are not in
 * the DOM. Under the harness the renderer installs a probe on
 * `window.__switchboardTerminals` (src/renderer/features/terminal/terminal-probe.ts)
 * that reads them off the xterm instance; these wrap it.
 */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TerminalProbeState } from '../../src/renderer/features/terminal/terminal-probe';

/** The session's whole buffer, scrollback included, one string per line. */
export async function terminalLines(page: Page, sessionId: string): Promise<string[]> {
  const lines = await page.evaluate(id => window.__switchboardTerminals!.lines(id), sessionId);
  if (!lines) throw new Error(`no open terminal for ${sessionId}`);
  return lines;
}

/** The session's buffer as one string, lines joined with `\n`. */
export async function terminalText(page: Page, sessionId: string): Promise<string> {
  return (await terminalLines(page, sessionId)).join('\n');
}

export async function terminalState(page: Page, sessionId: string): Promise<TerminalProbeState> {
  const state = await page.evaluate(id => window.__switchboardTerminals!.state(id), sessionId);
  if (!state) throw new Error(`no open terminal for ${sessionId}`);
  return state;
}

/** Whether the session has a terminal at all. */
export async function hasTerminal(page: Page, sessionId: string): Promise<boolean> {
  return page.evaluate(id => window.__switchboardTerminals!.sessionIds().includes(id), sessionId);
}

/** Wait until the terminal's buffer contains `text`. */
export async function expectTerminalText(page: Page, sessionId: string, text: string): Promise<void> {
  await expect.poll(() => terminalText(page, sessionId), { message: `the terminal to show ${JSON.stringify(text)}` })
    .toContain(text);
}

/** Scroll the terminal's viewport by `amount` lines (negative is up). */
export async function scrollTerminal(page: Page, sessionId: string, amount: number): Promise<void> {
  await page.evaluate(([id, n]) => window.__switchboardTerminals!.scrollLines(id as string, n as number), [sessionId, amount]);
}

/** Select `length` cells starting at a buffer position, as a mouse drag would. */
export async function selectInTerminal(
  page: Page, sessionId: string, column: number, row: number, length: number,
): Promise<void> {
  await page.evaluate(([id, c, r, l]) => window.__switchboardTerminals!.select(id as string, c as number, r as number, l as number),
    [sessionId, column, row, length]);
}

/** The page coordinates of the middle of a cell in the visible grid. */
export async function cellPoint(
  page: Page, sessionId: string, column: number, viewportRow: number,
): Promise<{ x: number; y: number }> {
  const { cell } = await terminalState(page, sessionId);
  return {
    x: cell.left + (column + 0.5) * cell.width,
    y: cell.top + (viewportRow + 0.5) * cell.height,
  };
}

/** Where `text` first appears in the buffer: its column, buffer row and row within the viewport. */
export async function findInTerminal(
  page: Page, sessionId: string, text: string,
): Promise<{ column: number; row: number; viewportRow: number }> {
  const lines = await terminalLines(page, sessionId);
  const row = lines.findIndex(line => line.includes(text));
  if (row === -1) throw new Error(`${JSON.stringify(text)} is not in the terminal`);
  const { viewportY } = await terminalState(page, sessionId);
  return { column: lines[row].indexOf(text), row, viewportRow: row - viewportY };
}
