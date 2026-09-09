/**
 * "New session, but let me choose the options."
 *
 * Every field is pre-filled from the project's effective settings, so the
 * dialog is a chance to override this one launch rather than a form to fill in.
 */
import { escapeHtml } from '../../lib/format';
import { shortProjectPath } from '../../../domain/project/project-path';
import { launchNewSession } from '../sessions/session-actions';
import { openDialog } from './dialog-shell';
import { applyPermissionSelection, bindPermissionGrid, permissionGridHtml } from './permission-grid';
import { dialogActionsHtml, readSessionFields, sessionFieldsHtml } from './session-fields';
import type { Project } from '../../../domain/project/project';
import type { SessionOptions } from '../../../domain/launch/session-options';
import type { SessionFieldsOptions } from './session-fields';

export async function showNewSessionDialog(project: Project): Promise<void> {
  const settings = await window.api.getEffectiveSettings(project.projectPath);
  const initial = {
    mode: settings.permissionMode ?? null,
    dangerousSkip: !!settings.dangerouslySkipPermissions,
  };
  const fields: SessionFieldsOptions = { prefix: 'nsd', settings, includeWorktree: true };

  const handle = openDialog({
    overlayClass: 'new-session-overlay',
    dialogClass: 'new-session-dialog',
    html: `
      <h3>New Session — ${escapeHtml(shortProjectPath(project.projectPath))}</h3>
      <div class="settings-field">
        <div class="settings-label">Permission Mode</div>
        <div class="permission-grid" id="nsd-mode-grid">${permissionGridHtml(initial)}</div>
      </div>
      ${sessionFieldsHtml(fields)}
      ${dialogActionsHtml('Start')}
    `,
  });

  const readPermissions = bindPermissionGrid(handle.field('#nsd-mode-grid'), initial);

  const start = (): void => {
    const options: SessionOptions = {};
    applyPermissionSelection(options, readPermissions());
    readSessionFields(handle, fields, options);
    handle.close();
    void launchNewSession(project, options);
  };

  handle.field('.new-session-cancel-btn').onclick = handle.close;
  handle.field('.new-session-start-btn').onclick = start;
  handle.onSubmit(start);
}
