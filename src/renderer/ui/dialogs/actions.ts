/**
 * What the dialogs do outside themselves: open and close through the store,
 * and the IPC calls behind their buttons.
 *
 * The components call these rather than `window.api` directly, so what a
 * dialog *does* reads in one place and the components stay about markup.
 */
import { dispatch } from '../../state/app-store';
import { loadProjects } from '../../features/sessions/session-list';
import { archiveSessionRow, launchClaudeSession } from '../../features/sessions/session-actions';
import { pollActiveSessions } from '../../features/sessions/session-poller';
import { projectLabel } from '../../features/sessions/project-label';
import { localProjectRequest, remoteProjectRequest } from './add-project-request';
import type { RemoteFields } from './add-project-request';
import type { DialogRequest } from '../../state/dialog-slice';
import type { IpcResult } from '../../../ipc/api';
import type { ProjectFolderCheck } from '../../../domain/project/folder-check';
import type { Project } from '../../../domain/project/project';
import type { SessionRow } from '../../../domain/session/session';

// ── Opening and closing ──

export function openDialog(request: DialogRequest): void {
  dispatch({ type: 'dialogOpened', request });
}

/** Close the dialog opened as `seq`, if it is still the one open. */
export function closeDialog(seq: number): void {
  dispatch({ type: 'dialogClosed', seq });
}

/**
 * Open the resume dialog, once its settings are in.
 *
 * Fetched first so the form is drawn already filled in, as the vanilla dialog
 * was, rather than flashing defaults and then changing under the user.
 */
export async function openResumeDialog(session: SessionRow): Promise<void> {
  const settings = await window.api.getEffectiveSettings(session.projectPath);
  openDialog({ kind: 'resumeSession', session, settings });
}

// ── Starting a session from the picker ──

/**
 * Start a session in the project picked, on the prompt the picker was opened
 * carrying, if any (#135, O3).
 *
 * Once that session has started, the box the prompt came from is told it has
 * done its job. A remote project does not take a starting prompt yet, so the
 * box keeps its text for another try.
 */
export async function launchFromPicker(project: Project, initialPrompt?: string): Promise<void> {
  const carried = initialPrompt !== undefined && !project.remote;
  await launchClaudeSession(project, carried ? { initialPrompt } : {});
  if (carried) dispatch({ type: 'pickerPromptLaunched' });
}

// ── Adding a project ──

export type { RemoteFields } from './add-project-request';

/** What adding a project came to: the error to show, or the path it was added as. */
export type AddOutcome = { error: string } | { projectPath: string };

/**
 * Add a local folder (a leading `~` is fine), then reload the projects so the
 * modal can list it.
 *
 * Only the empty field is caught here, so the user is not waiting on a round
 * trip to be told it is blank; the validation that matters is in main.
 */
export async function addLocalProject(projectPath: string): Promise<AddOutcome> {
  const request = localProjectRequest(projectPath);
  if ('error' in request) return request;
  return added(await window.api.addProject(request.path));
}

/** Add a machine over SSH, then reload the projects. */
export async function addRemoteProject(fields: RemoteFields): Promise<AddOutcome> {
  const request = remoteProjectRequest(fields);
  if ('error' in request) return request;
  return added(await window.api.addRemoteProject(request.config));
}

async function added(result: IpcResult): Promise<AddOutcome> {
  if (result.error) return { error: result.error };
  await loadProjects();
  return { projectPath: String(result.projectPath) };
}

/** What the folder the user is typing would give, for the inline check (#171). */
export function checkProjectFolder(typed: string): Promise<ProjectFolderCheck> {
  return window.api.checkProjectFolder(typed);
}

/** The native folder picker; null when it was cancelled. */
export function browseForFolder(): Promise<string | null> {
  return window.api.browseFolder();
}

/** The project's repository in the browser; nothing happens for one without a web page. */
export function openProjectOnGitHub(project: Project): void {
  void window.api.openRepository(project.projectPath);
}

// ── The project picker's row actions ──
//
// Each asks first with a native confirm(), and answers whether it went ahead,
// so the picker knows to redraw its list.

/** Forget a remote project. Its tmux sessions on the far host keep running. */
export async function removeRemoteProject(project: Project): Promise<boolean> {
  const message = `Remove ${projectLabel(project.projectPath)}?\n\n`
    + 'This disconnects open connections. tmux sessions on the remote machine keep running.';
  if (!confirm(message)) return false;
  await window.api.removeRemoteProject(project.projectPath);
  await loadProjects();
  return true;
}

/** Hide a local project until it is added again. Its session files stay on disk. */
export async function hideProject(project: Project): Promise<boolean> {
  if (!confirm(`Hide ${projectLabel(project.projectPath)}?\n\nSession files are not deleted. Add the folder again to bring it back.`)) return false;
  await window.api.removeProject(project.projectPath);
  await loadProjects();
  return true;
}

/** Archive every unarchived session in the project, one at a time. */
export async function archiveAllSessions(project: Project): Promise<boolean> {
  const sessions = project.sessions.filter(s => !s.archived);
  if (sessions.length === 0) return false;

  const plural = sessions.length > 1 ? 's' : '';
  if (!confirm(`Archive all ${sessions.length} session${plural} in ${projectLabel(project.projectPath)}?`)) return false;

  for (const session of sessions) {
    // One failure stops the sweep rather than silently skipping a session whose
    // PTY is still running.
    if (!await archiveSessionRow(session, 1)) break;
  }

  void pollActiveSessions();
  await loadProjects();
  return true;
}
