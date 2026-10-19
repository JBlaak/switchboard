/**
 * The contract between main and the Quick Ask pop-up (#142).
 *
 * The pop-up is a window of its own, with its own preload, so it gets its own
 * global, `window.quickAsk`, typed against this — not the main window's
 * `window.api`. Main does the routing (R1); the pop-up only sends the text and
 * shows what came of it.
 */
import type { Unsubscribe } from './api';

/** Where a capture goes: BlaakTasks, or James (C1). */
export type CaptureTarget = 'tasks' | 'james';

/** What came of a send, or of a choice from the list. */
export type QuickAskReply =
  /** The session is starting in this project's folder (B7). */
  | { kind: 'started'; folder: string }
  /** Patch is unsure: these projects, best first (R2). */
  | { kind: 'choose'; candidates: { projectPath: string; folder: string }[] }
  /** The main window took the text, in its New Session picker (R2). */
  | { kind: 'handedOff' }
  /** A task or a save was written (C4). */
  | { kind: 'saved'; target: CaptureTarget; summary: string }
  /** A capture failed; the text stays, to retry (C5). */
  | { kind: 'captureFailed'; reason: string }
  /** Cancelled: back to editing. */
  | { kind: 'unlocked' };

export interface QuickAskApi {
  route(text: string): Promise<QuickAskReply>;
  cancel(): Promise<void>;
  /** A choice from the list. */
  start(projectPath: string): Promise<QuickAskReply>;
  /** Tab: the New Session picker in the main window. */
  openPicker(): Promise<void>;
  /** ⌘Z after a capture. */
  undo(): Promise<{ ok: boolean }>;
  /** Hide the pop-up. */
  dismiss(): void;
  /** The pop-up came on screen. */
  onShown(listener: () => void): Unsubscribe;

  // ── The window's own plumbing ──

  /**
   * ⌥Space while the pop-up is showing (H1). The pop-up decides: it closes
   * unless it is waiting or saving (B4).
   */
  onCloseRequested(listener: () => void): Unsubscribe;
  /**
   * Whether the pointer is over the slab. Everywhere else the window lets the
   * mouse through to whatever is underneath (G3).
   */
  pointerOverSlab(over: boolean): void;
}
