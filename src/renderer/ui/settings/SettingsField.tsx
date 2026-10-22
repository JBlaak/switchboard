/**
 * One row of the settings form: a label and description on the left, the
 * control on the right (or below, for a wide one).
 *
 * Two shapes, because the vanilla form had two and the stylesheet follows
 * them: a launch option sits in a header row of its own (a project's override
 * of one is on the project's page now, #176); an application setting's label
 * stands alone.
 */
import type { JSX, ReactNode } from 'react';

interface FieldProps {
  label: string;
  description: ReactNode;
  wide?: boolean;
  /** Omitted for a row with nothing to set, like the version. */
  children?: ReactNode;
}

function rowClass(wide: boolean | undefined): string {
  return wide ? 'settings-field settings-field-wide' : 'settings-field';
}

/** A launch option, the default a project can override on its page. */
export function LaunchField({ label, description, wide, children }: FieldProps): JSX.Element {
  return (
    <div className={rowClass(wide)}>
      <div className="settings-field-info">
        <div className="settings-field-header">
          <span className="settings-label">{label}</span>
        </div>
        <div className="settings-description">{description}</div>
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

/** An application setting. */
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
