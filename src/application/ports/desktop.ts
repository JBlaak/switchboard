/**
 * The desktop the app is running on.
 *
 * The handful of host capabilities a use case legitimately needs — a folder
 * picker, the system browser, the clipboard, the app's own version — and the
 * auto-updater. Kept as small separate ports rather than one "electron"
 * grab-bag so a use case declares only what it actually reaches for.
 */

export interface DialogService {
  /** The folder the user chose, or null if they cancelled. */
  chooseDirectory(title: string): Promise<string | null>;
}

export interface SystemGateway {
  /** Opens http(s) in the user's browser; anything else is ignored. */
  openExternal(url: string): Promise<void>;
  /**
   * Copy text to the clipboard.
   *
   * Goes through the host rather than the renderer's `navigator.clipboard`,
   * which is gated on focus and user activation and is flaky-to-dead on
   * Linux/Wayland.
   */
  writeClipboard(text: string): void;
  appVersion(): string;
}

/** Result of asking the updater to look for a new version. */
export interface UpdateCheckResult {
  available: boolean;
  /** True in a development build, where there is nothing to update from. */
  dev?: boolean;
  [key: string]: unknown;
}

export interface Updater {
  /** False in an unpackaged build, where the rest of this does nothing. */
  readonly enabled: boolean;
  check(): Promise<UpdateCheckResult>;
  download(): Promise<void>;
  /** Quits and relaunches into the downloaded version. */
  install(): void;
}
