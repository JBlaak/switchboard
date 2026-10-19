/**
 * The contract between main and the Quick Ask pop-up (#142).
 *
 * The pop-up is a window of its own, with its own preload, so it gets its own
 * global, `window.quickAsk`, typed against this — not the main window's
 * `window.api`. Main does the routing (R1); the pop-up only sends the text and
 * shows what came of it.
 */
import type { Unsubscribe } from './api';
import type { QuickAskReply } from '../domain/ask/quick-ask';

import type { CaptureTarget } from '../domain/ask/model';

export type { CaptureTarget };
/** What came of a send, or of a choice from the list; main's `QuickAskService` answers it. */
export type { QuickAskReply };

/** The system's accessibility settings, read as the pop-up shows (#150). */
export interface QuickAskLooks {
  /** Every moment becomes a short fade. */
  reduceMotion: boolean;
  /** The glass is a solid surface. */
  reduceTransparency: boolean;
}

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
  /** A send turned out to be a capture into `target`, and main is writing it. */
  onSaving(listener: (target: CaptureTarget) => void): Unsubscribe;
  /** The pop-up came on screen, with the system's settings as they are now. */
  onShown(listener: (looks: QuickAskLooks) => void): Unsubscribe;

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
