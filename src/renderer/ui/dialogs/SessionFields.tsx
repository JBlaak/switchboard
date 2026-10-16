/**
 * The launch fields of the resume dialog, below its permission grid.
 *
 * There is no worktree field: resuming a session has to reuse the directory it
 * already lives in.
 */
import type { JSX } from 'react';
import type { EffectiveSettings } from '../../../domain/settings/settings';
import type { SessionOptions } from '../../../domain/launch/session-options';

export interface SessionFieldValues {
  chrome: boolean;
  preLaunchCmd: string;
  addDirs: string;
}

export function initialSessionFields(settings: EffectiveSettings): SessionFieldValues {
  return {
    chrome: !!settings.chrome,
    preLaunchCmd: settings.preLaunchCmd || '',
    addDirs: settings.addDirs || '',
  };
}

/** Fold the fields into the launch options. */
export function applySessionFields(options: SessionOptions, values: SessionFieldValues): void {
  if (values.chrome) options.chrome = true;

  const preLaunch = values.preLaunchCmd.trim();
  if (preLaunch) options.preLaunchCmd = preLaunch;

  options.addDirs = values.addDirs.trim();
}

export interface SessionFieldsProps {
  values: SessionFieldValues;
  onChange(values: SessionFieldValues): void;
}

export function SessionFields({ values, onChange }: SessionFieldsProps): JSX.Element {
  return (
    <>
      <div className="settings-field">
        <div className="settings-field-info">
          <span className="settings-label">Chrome</span>
          <div className="settings-description">Enable Chrome browser automation</div>
        </div>
        <div className="settings-field-control">
          <label className="settings-toggle">
            <input type="checkbox" id="rsd-chrome" checked={values.chrome}
              onChange={e => onChange({ ...values, chrome: e.target.checked })} />
            <span className="settings-toggle-slider" />
          </label>
        </div>
      </div>
      <TextField id="rsd-pre-launch" label="Pre-launch Command" description="Prepended to the claude command"
        placeholder="e.g. aws-vault exec profile --" value={values.preLaunchCmd}
        onChange={preLaunchCmd => onChange({ ...values, preLaunchCmd })} />
      <TextField id="rsd-add-dirs" label="Additional Directories"
        description="Extra directories to include (comma-separated)" placeholder="/path/to/dir1, /path/to/dir2"
        value={values.addDirs} onChange={addDirs => onChange({ ...values, addDirs })} />
    </>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  description: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
}

function TextField({ id, label, description, placeholder, value, onChange }: TextFieldProps): JSX.Element {
  return (
    <div className="settings-field settings-field-wide">
      <div className="settings-field-info">
        <span className="settings-label">{label}</span>
        <div className="settings-description">{description}</div>
      </div>
      <div className="settings-field-control">
        <input type="text" className="settings-input" id={id} placeholder={placeholder} value={value}
          onChange={e => onChange(e.target.value)} />
      </div>
    </div>
  );
}
