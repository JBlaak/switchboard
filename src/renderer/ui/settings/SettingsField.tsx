/**
 * One row of the settings form: a label and description on the left, the
 * control on the right (or below, for a wide one).
 *
 * Two shapes, because the vanilla form had two and the stylesheet follows
 * them: a launch option sits in a header row that, in project scope, also
 * holds its "Use global default" checkbox; an application setting is global
 * only, so its label stands alone.
 */
import type { JSX, ReactNode } from 'react';

interface FieldProps {
  label: string;
  description: ReactNode;
  wide?: boolean;
  /** Omitted for a row with nothing to set, like the version. */
  children?: ReactNode;
}

interface LaunchFieldProps extends FieldProps {
  /** Project scope only: whether the field follows the global value. */
  useGlobal?: { checked: boolean; field: string; onChange(checked: boolean): void };
}

function rowClass(wide: boolean | undefined): string {
  return wide ? 'settings-field settings-field-wide' : 'settings-field';
}

/** A launch option, which a project can override. */
export function LaunchField({ label, description, wide, useGlobal, children }: LaunchFieldProps): JSX.Element {
  return (
    <div className={rowClass(wide)}>
      <div className="settings-field-info">
        <div className="settings-field-header">
          <span className="settings-label">{label}</span>
          {useGlobal && (
            <label className="settings-use-global">
              <input
                type="checkbox"
                data-field={useGlobal.field}
                className="use-global-cb"
                checked={useGlobal.checked}
                onChange={e => useGlobal.onChange(e.currentTarget.checked)}
              /> Use global default
            </label>
          )}
        </div>
        <div className="settings-description">{description}</div>
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

/** An application setting, global only. */
export function AppField({ label, description, wide, children }: FieldProps): JSX.Element {
  return (
    <div className={rowClass(wide)}>
      <div className="settings-field-info">
        <span className="settings-label">{label}</span>
        <div className="settings-description">{description}</div>
      </div>
      {children !== undefined && <div className="settings-field-control">{children}</div>}
    </div>
  );
}
