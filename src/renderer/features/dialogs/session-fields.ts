/**
 * The launch fields the new-session and resume dialogs have in common.
 *
 * Two dialogs, almost the same form: resuming a session cannot create a
 * worktree (it has to reuse the directory the session already lives in), so
 * that one field is the only difference.
 */
import { escapeHtml } from '../../lib/format';
import type { EffectiveSettings } from '../../../domain/settings/settings';
import type { SessionOptions } from '../../../domain/launch/session-options';
import type { DialogHandle } from './dialog-shell';

/** The prefix on the field ids, so two dialogs can be open without colliding. */
export type FieldPrefix = 'nsd' | 'rsd';

function toggleField(id: string, label: string, description: string, checked: boolean): string {
  return `
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">${label}</span>
        <div class="settings-description">${description}</div>
      </div>
      <div class="settings-field-control">
        <label class="settings-toggle"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>`;
}

function textField(id: string, label: string, description: string, placeholder: string, value: string): string {
  return `
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">${label}</span>
        <div class="settings-description">${description}</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="${id}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">
      </div>
    </div>`;
}

/** The worktree row: a name and a switch, side by side. */
function worktreeField(prefix: FieldPrefix, settings: EffectiveSettings): string {
  return `
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Worktree</span>
        <div class="settings-description">Run session in an isolated git worktree</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="${prefix}-worktree-name" placeholder="name (optional)" value="${escapeHtml(settings.worktreeName || '')}" style="width:140px">
        <label class="settings-toggle"><input type="checkbox" id="${prefix}-worktree" ${settings.worktree ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>`;
}

export interface SessionFieldsOptions {
  prefix: FieldPrefix;
  settings: EffectiveSettings;
  /** Resuming reuses the session's own directory, so it has no worktree field. */
  includeWorktree: boolean;
}

export function sessionFieldsHtml({ prefix, settings, includeWorktree }: SessionFieldsOptions): string {
  return [
    includeWorktree ? worktreeField(prefix, settings) : '',
    toggleField(`${prefix}-chrome`, 'Chrome', 'Enable Chrome browser automation', !!settings.chrome),
    textField(`${prefix}-pre-launch`, 'Pre-launch Command',
      'Prepended to the claude command', 'e.g. aws-vault exec profile --',
      settings.preLaunchCmd || ''),
    textField(`${prefix}-add-dirs`, 'Additional Directories',
      'Extra directories to include (comma-separated)', '/path/to/dir1, /path/to/dir2',
      settings.addDirs || ''),
  ].join('');
}

/** Read the fields back into launch options. */
export function readSessionFields(
  handle: DialogHandle,
  { prefix, settings, includeWorktree }: SessionFieldsOptions,
  options: SessionOptions,
): void {
  if (includeWorktree && handle.field<HTMLInputElement>(`#${prefix}-worktree`).checked) {
    options.worktree = true;
    options.worktreeName = handle.field<HTMLInputElement>(`#${prefix}-worktree-name`).value.trim();
  }
  if (handle.field<HTMLInputElement>(`#${prefix}-chrome`).checked) options.chrome = true;

  const preLaunch = handle.field<HTMLInputElement>(`#${prefix}-pre-launch`).value.trim();
  if (preLaunch) options.preLaunchCmd = preLaunch;

  options.addDirs = handle.field<HTMLInputElement>(`#${prefix}-add-dirs`).value.trim();

  // The IDE bridge is a global preference, not a per-launch one; it rides along
  // so the main process does not have to look it up again.
  if (settings.mcpEmulation === false) options.mcpEmulation = false;
}

/** The two buttons every launch dialog ends with. */
export function dialogActionsHtml(confirmLabel: string): string {
  return `
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">${escapeHtml(confirmLabel)}</button>
    </div>`;
}
