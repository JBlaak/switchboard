/**
 * The rules of the resume dialog's permission grid.
 *
 * A grid of mutually exclusive modes plus one that is deliberately set apart:
 * `--dangerously-skip-permissions` is not a mode the CLI takes alongside
 * `--permission-mode`, it replaces it, so selecting it clears the mode and
 * picking a mode clears it.
 *
 * Pure, so the rules are tested without a DOM.
 */
import type { EffectiveSettings } from '../../../domain/settings/settings';
import type { SessionOptions } from '../../../domain/launch/session-options';

export interface PermissionSelection {
  mode: string | null;
  dangerousSkip: boolean;
}

/** What the grid's control for Dangerous Skip is keyed by, beside the mode values. */
export const DANGEROUS_SKIP = 'dangerous-skip';

/** The selection a dialog opens with: the project's effective settings. */
export function initialPermissionSelection(settings: EffectiveSettings): PermissionSelection {
  return { mode: settings.permissionMode ?? null, dangerousSkip: !!settings.dangerouslySkipPermissions };
}

/**
 * The selection after clicking one option.
 *
 * Dangerous Skip toggles, and turning it on clears the mode; turning it back
 * off does not bring that mode back. Any mode (null being "Default") turns
 * Dangerous Skip off.
 */
export function pickPermission(selection: PermissionSelection, option: string | null): PermissionSelection {
  if (option === DANGEROUS_SKIP) {
    const dangerousSkip = !selection.dangerousSkip;
    return { mode: dangerousSkip ? null : selection.mode, dangerousSkip };
  }
  return { mode: option, dangerousSkip: false };
}

/** Fold a selection into the launch options. */
export function applyPermissionSelection(
  options: SessionOptions,
  { mode, dangerousSkip }: PermissionSelection,
): void {
  if (dangerousSkip) options.dangerouslySkipPermissions = true;
  else if (mode) options.permissionMode = mode;
}
