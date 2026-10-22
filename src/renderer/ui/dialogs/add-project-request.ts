/**
 * What the Projects modal's add step asks main for, and how it reads the
 * answer to its folder check.
 *
 * Only the empty-field cases are caught here, so the user is not waiting on a
 * round trip to be told a field is blank; the validation that matters is in
 * main. Pure, so the rules run under the node test runner without a DOM.
 */
import type { RemoteConfig } from '../../../domain/project/remote-target';
import type { ProjectFolderCheck } from '../../../domain/project/folder-check';

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

// ── The inline check (#171) ──

/** One line of the add step's check: what was found, and whether it is good news. */
export interface CheckLine {
  ok: boolean;
  text: string;
}

/**
 * The add step's check, line by line. A folder that is missing stops there;
 * one outside a repository or off GitHub still adds, with less to show.
 */
export function folderCheckLines(check: ProjectFolderCheck): CheckLine[] {
  if (!check.exists) return [{ ok: false, text: 'No folder at this path' }];
  if (!check.directory) return [{ ok: false, text: 'This is a file, not a folder' }];
  const lines: CheckLine[] = [{ ok: true, text: 'Folder exists' }];
  if (!check.git) {
    lines.push({ ok: false, text: 'Not a git repository' });
    return lines;
  }
  lines.push({ ok: true, text: check.branch ? `Git repository on ${check.branch}` : 'Git repository' });
  lines.push(check.gitHubRepository
    ? { ok: true, text: `On GitHub as ${check.gitHubRepository}, so plans and PRs will show` }
    : { ok: false, text: 'Not on GitHub' });
  return lines;
}

/** The "Add folder" row's second line, from the check (null while it is on its way). */
export function folderSummary(check: ProjectFolderCheck | null, alreadyAdded: boolean): string {
  if (!check) return 'Checking…';
  if (!check.exists) return 'No folder at this path';
  if (!check.directory) return 'This is a file, not a folder';
  const parts = [check.git ? 'Git repository' : 'Folder, not a git repository'];
  if (check.gitHubRepository) parts.push('github.com/' + check.gitHubRepository);
  parts.push(alreadyAdded ? 'already added' : 'not added yet');
  return parts.join(' · ');
}

/** Whether ↵ on the "Add folder" row can add it: the check found a folder there. */
export function canAddFolder(check: ProjectFolderCheck | null): boolean {
  return !!check && check.exists && check.directory;
}
