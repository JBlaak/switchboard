/**
 * The permission-mode picker, shared by the new-session and resume dialogs.
 *
 * A grid of mutually exclusive options plus one that is deliberately set apart:
 * `--dangerously-skip-permissions` is not a mode the CLI takes alongside
 * `--permission-mode`, it replaces it, so selecting it clears the others and
 * vice versa.
 */
import { PERMISSION_MODES } from '../../../domain/launch/session-options';
import type { SessionOptions } from '../../../domain/launch/session-options';

export interface PermissionSelection {
  mode: string | null;
  dangerousSkip: boolean;
}

/** The grid's markup for a given selection. */
function renderGrid({ mode, dangerousSkip }: PermissionSelection): string {
  const options = PERMISSION_MODES.map(option => {
    const selected = !dangerousSkip && mode === option.value;
    return `<button class="permission-option${selected ? ' selected' : ''}" data-mode="${option.value}">`
      + `<span class="perm-name">${option.label}</span>`
      + `<span class="perm-desc">${option.desc}</span></button>`;
  }).join('');

  return options
    + `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip">`
    + '<span class="perm-name">Dangerous Skip</span>'
    + '<span class="perm-desc">Skip all safety prompts (use with caution)</span></button>';
}

/** The grid's initial markup, for a dialog's template string. */
export function permissionGridHtml(initial: PermissionSelection): string {
  return renderGrid(initial);
}

/**
 * Make a rendered grid interactive.
 *
 * Answers with a getter for the current selection, so the dialog reads it when
 * the user submits rather than tracking it alongside.
 */
export function bindPermissionGrid(
  grid: HTMLElement,
  initial: PermissionSelection,
): () => PermissionSelection {
  const selection: PermissionSelection = { ...initial };

  grid.addEventListener('click', (e: MouseEvent) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('.permission-option');
    if (!button) return;

    const mode = button.dataset.mode;
    if (mode === 'dangerous-skip') {
      selection.dangerousSkip = !selection.dangerousSkip;
      if (selection.dangerousSkip) selection.mode = null;
    } else {
      selection.dangerousSkip = false;
      selection.mode = mode === 'null' ? null : mode ?? null;
    }
    grid.innerHTML = renderGrid(selection);
  });

  return () => ({ ...selection });
}

/** Fold a selection into the launch options. */
export function applyPermissionSelection(
  options: SessionOptions,
  { mode, dangerousSkip }: PermissionSelection,
): void {
  if (dangerousSkip) options.dangerouslySkipPermissions = true;
  else if (mode) options.permissionMode = mode;
}
