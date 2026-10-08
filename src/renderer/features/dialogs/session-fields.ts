/**
 * The launch fields of the resume dialog, below its permission grid.
 *
 * There is no worktree field: resuming a session has to reuse the directory it
 * already lives in.
 */
import { escapeHtml } from '../../lib/format';
import type { EffectiveSettings } from '../../../domain/settings/settings';
import type { SessionOptions } from '../../../domain/launch/session-options';
import type { DialogHandle } from './dialog-shell';

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

export function sessionFieldsHtml(settings: EffectiveSettings): string {
  return [
    toggleField('rsd-chrome', 'Chrome', 'Enable Chrome browser automation', !!settings.chrome),
    textField('rsd-pre-launch', 'Pre-launch Command',
      'Prepended to the claude command', 'e.g. aws-vault exec profile --',
      settings.preLaunchCmd || ''),
    textField('rsd-add-dirs', 'Additional Directories',
      'Extra directories to include (comma-separated)', '/path/to/dir1, /path/to/dir2',
      settings.addDirs || ''),
  ].join('');
}

/** Read the fields back into launch options. */
export function readSessionFields(handle: DialogHandle, options: SessionOptions): void {
  if (handle.field<HTMLInputElement>('#rsd-chrome').checked) options.chrome = true;

  const preLaunch = handle.field<HTMLInputElement>('#rsd-pre-launch').value.trim();
  if (preLaunch) options.preLaunchCmd = preLaunch;

  options.addDirs = handle.field<HTMLInputElement>('#rsd-add-dirs').value.trim();
}

/** The dialog's Cancel and confirm buttons. */
export function dialogActionsHtml(confirmLabel: string): string {
  return `
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">${escapeHtml(confirmLabel)}</button>
    </div>`;
}
