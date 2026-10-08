/**
 * "Resume this session, but change how."
 *
 * Every launch option but the worktree: resuming has to reuse the directory the
 * session already lives in, so a worktree option would be silently ignored by
 * the CLI.
 */
import { escapeHtml } from '../../lib/format';
import { openSession } from '../sessions/session-actions';
import { openDialog } from './dialog-shell';
import { applyPermissionSelection, bindPermissionGrid, permissionGridHtml } from './permission-grid';
import { dialogActionsHtml, readSessionFields, sessionFieldsHtml } from './session-fields';
import type { SessionOptions } from '../../../domain/launch/session-options';
import type { SessionRow } from '../../../domain/session/session';

export async function showResumeSessionDialog(session: SessionRow): Promise<void> {
  const settings = await window.api.getEffectiveSettings(session.projectPath);
  const initial = {
    mode: settings.permissionMode ?? null,
    dangerousSkip: !!settings.dangerouslySkipPermissions,
  };

  const name = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);

  const handle = openDialog({
    overlayClass: 'new-session-overlay',
    dialogClass: 'new-session-dialog',
    html: `
      <h3>Resume Session — ${escapeHtml(name)}</h3>
      <div class="settings-field">
        <div class="settings-label">Permission Mode</div>
        <div class="permission-grid" id="rsd-mode-grid">${permissionGridHtml(initial)}</div>
      </div>
      ${sessionFieldsHtml(settings)}
      ${dialogActionsHtml('Resume')}
    `,
  });

  const readPermissions = bindPermissionGrid(handle.field('#rsd-mode-grid'), initial);

  const resume = (): void => {
    const options: SessionOptions = {};
    applyPermissionSelection(options, readPermissions());
    readSessionFields(handle, options);
    handle.close();
    void openSession(session, options);
  };

  handle.field('.new-session-cancel-btn').onclick = handle.close;
  handle.field('.new-session-start-btn').onclick = resume;
  handle.onSubmit(resume);
}
