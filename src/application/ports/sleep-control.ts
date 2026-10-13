/**
 * The host's "never sleep" switch, `pmset disablesleep`.
 *
 * Both methods answer null rather than rejecting when the host cannot say —
 * not a Mac, or the user cancelled the password prompt — so the button can
 * show what is true instead of an error.
 */
export interface SleepControl {
  /** True when sleep is disabled, null when it cannot be read. */
  isSleepDisabled(): Promise<boolean | null>;
  /** Flip the switch, then answer with the state actually read back. */
  setSleepDisabled(disabled: boolean): Promise<boolean | null>;
}
