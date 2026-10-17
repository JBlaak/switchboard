/**
 * What the Add Project dialog's fields ask main for.
 *
 * Only the empty-field cases are caught here, so the user is not waiting on a
 * round trip to be told a field is blank; the validation that matters is in
 * main. Pure, so the rules run under the node test runner without a DOM.
 */
import type { RemoteConfig } from '../../../domain/project/remote-target';

export interface RemoteFields {
  user: string;
  host: string;
  port: string;
  dir: string;
}

/** The folder to add, or the error to show instead. */
export function localProjectRequest(projectPath: string): { path: string } | { error: string } {
  const path = projectPath.trim();
  return path ? { path } : { error: 'Please enter a folder path.' };
}

/** The remote to add, or the error to show instead. A blank or unreadable port is 22. */
export function remoteProjectRequest(fields: RemoteFields): { config: RemoteConfig } | { error: string } {
  const user = fields.user.trim();
  const host = fields.host.trim();
  if (!user || !host) return { error: 'Please enter a username and host.' };
  return { config: { user, host, port: Number(fields.port.trim()) || 22, dir: fields.dir.trim() } };
}
