/**
 * The permission-mode picker in the resume dialog.
 *
 * Controlled: the dialog holds the selection, and the rules for what a click
 * does to it are `pickPermission`'s.
 */
import { PERMISSION_MODES } from '../../../domain/launch/session-options';
import { DANGEROUS_SKIP, pickPermission } from './permission-selection';
import type { JSX } from 'react';
import type { PermissionSelection } from './permission-selection';

export interface PermissionGridProps {
  id: string;
  selection: PermissionSelection;
  onChange(selection: PermissionSelection): void;
}

export function PermissionGrid({ id, selection, onChange }: PermissionGridProps): JSX.Element {
  const { mode, dangerousSkip } = selection;
  return (
    <div className="permission-grid" id={id}>
      {PERMISSION_MODES.map(option => (
        <button
          key={String(option.value)}
          className={'permission-option' + (!dangerousSkip && mode === option.value ? ' selected' : '')}
          data-mode={String(option.value)}
          onClick={() => onChange(pickPermission(selection, option.value))}
        >
          <span className="perm-name">{option.label}</span>
          <span className="perm-desc">{option.desc}</span>
        </button>
      ))}
      <button
        className={'permission-option dangerous' + (dangerousSkip ? ' selected' : '')}
        data-mode={DANGEROUS_SKIP}
        onClick={() => onChange(pickPermission(selection, DANGEROUS_SKIP))}
      >
        <span className="perm-name">Dangerous Skip</span>
        <span className="perm-desc">Skip all safety prompts (use with caution)</span>
      </button>
    </div>
  );
}
