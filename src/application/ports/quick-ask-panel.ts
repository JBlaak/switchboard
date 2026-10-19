/**
 * Quick Ask (#142): the pop-up, and the system-wide shortcut that opens it.
 *
 * Both are the host's: a window of its own, and a key the OS hands to whichever
 * app registered it first. Behind interfaces so the rule that decides when the
 * shortcut is held can be tested without Electron.
 */

/** The Quick Ask pop-up. */
export interface QuickAskPanel {
  show(): void;
  hide(): void;
  /** Show it, or hide it when it is already showing (H1). */
  toggle(): void;
  readonly visible: boolean;
}

/** A shortcut that reaches the app from anywhere on the Mac. */
export interface GlobalHotkey {
  /** False when the OS refused it, most often because another app holds it. */
  register(accelerator: string, onPress: () => void): boolean;
  unregister(accelerator: string): void;
}
