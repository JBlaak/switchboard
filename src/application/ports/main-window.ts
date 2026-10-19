/**
 * The main window, as something to open and bring forward.
 *
 * Quick Ask (#142) starts its sessions there while Switchboard stays in the
 * background, so the window has to exist without being made active (R4), and
 * only the New Session picker brings it forward.
 */
export interface MainWindowHost {
  /** Open it, without focus, if it is closed; nothing when it is open. */
  ensureOpen(): void;
  /** Open it if it is closed, and bring it and the app forward. */
  bringForward(): void;
}
