/**
 * "Resume this session, but change how."
 *
 * Every launch option but the worktree: resuming has to reuse the directory the
 * session already lives in, so a worktree option would be silently ignored by
 * the CLI.
 */
import { useState } from 'react';
import { openSession } from '../../features/sessions/session-actions';
import { DialogShell } from './DialogShell';
import { PermissionGrid } from './PermissionGrid';
import { SessionFields, applySessionFields, initialSessionFields } from './SessionFields';
import { applyPermissionSelection } from './permission-selection';
import type { JSX } from 'react';
import type { EffectiveSettings } from '../../../domain/settings/settings';
import type { SessionOptions } from '../../../domain/launch/session-options';
import type { SessionRow } from '../../../domain/session/session';
import type { PermissionSelection } from './permission-selection';

export interface ResumeSessionDialogProps {
  session: SessionRow;
  /** The effective settings for the session's project, fetched before opening. */
  settings: EffectiveSettings;
  onClose(): void;
}

export function ResumeSessionDialog({ session, settings, onClose }: ResumeSessionDialogProps): JSX.Element {
  const [permissions, setPermissions] = useState<PermissionSelection>(() => ({
    mode: settings.permissionMode ?? null,
    dangerousSkip: !!settings.dangerouslySkipPermissions,
  }));
  const [fields, setFields] = useState(() => initialSessionFields(settings));

  const name = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);

  const resume = (): void => {
    const options: SessionOptions = {};
    applyPermissionSelection(options, permissions);
    applySessionFields(options, fields);
    onClose();
    void openSession(session, options);
  };

  return (
    <DialogShell overlayClass="new-session-overlay" dialogClass="new-session-dialog" onClose={onClose} onSubmit={resume}>
      <h3>{`Resume Session — ${name}`}</h3>
      <div className="settings-field">
        <div className="settings-label">Permission Mode</div>
        <PermissionGrid id="rsd-mode-grid" selection={permissions} onChange={setPermissions} />
      </div>
      <SessionFields values={fields} onChange={setFields} />
      <div className="new-session-actions">
        <button className="new-session-cancel-btn" onClick={onClose}>Cancel</button>
        <button className="new-session-start-btn" onClick={resume}>Resume</button>
      </div>
    </DialogShell>
  );
}
