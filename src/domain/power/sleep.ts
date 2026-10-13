/**
 * Whether the Mac is allowed to sleep, as `pmset disablesleep` leaves it.
 *
 * `pmset -g` prints a `SleepDisabled` line among its settings: 1 after
 * `pmset disablesleep 1`, 0 after `pmset disablesleep 0`. That flag is the
 * whole question — the `sleep` line's "(sleep prevented by …)" lists the
 * temporary assertions apps such as caffeinate hold, which end on their own and
 * are not what the switch controls.
 */

/** True when sleep is disabled, false when it is allowed, null when the output does not say. */
export function parseSleepDisabled(pmsetOutput: string): boolean | null {
  const match = /^\s*SleepDisabled\s+(\d+)\s*$/m.exec(pmsetOutput);
  if (!match) return null;
  return match[1] !== '0';
}

/** The `pmset` arguments that put the switch in this position. */
export function disableSleepArgs(disabled: boolean): string[] {
  return ['disablesleep', disabled ? '1' : '0'];
}
