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
import type { Project } from '../../../domain/project/project';
import type { SessionRow } from '../../../domain/session/session';
import type { PlanSummary } from '../../../domain/plan/model';

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

/**
 * Add a local folder. Answers with an error message, or null on success.
 *
 * Only the empty field is caught here, so the user is not waiting on a round
 * trip to be told it is blank; the validation that matters is in main.
 */
export async function addLocalProject(projectPath: string): Promise<string | null> {
  const request = localProjectRequest(projectPath);
  if ('error' in request) return request.error;
  const result = await window.api.addProject(request.path);
  return result.error ?? null;
}

/** Add a machine over SSH. Answers with an error message, or null on success. */
export async function addRemoteProject(fields: RemoteFields): Promise<string | null> {
  const request = remoteProjectRequest(fields);
  if ('error' in request) return request.error;
  const result = await window.api.addRemoteProject(request.config);
  return result.error ?? null;
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

/** Hide a worktree project. Its session files stay on disk. */
export async function hideWorktree(project: Project): Promise<boolean> {
  const name = project.projectPath.split('/').pop();
  if (!confirm(`Hide worktree "${name}"?\n\nSession files are not deleted.`)) return false;
  await window.api.removeProject(project.projectPath);
  await loadProjects();
  return true;
}

// ── Plans in the picker (F1, F3) ──

/**
 * Projects that answered no plans and gave no sign of being on GitHub: their
 * row loses its → cue for the rest of the run, so the picker stops promising
 * what it cannot show.
 */
const withoutPlans = new Set<string>();

/**
 * Whether a project's row offers its plans. The renderer has no project's
 * remote, so a local project is assumed to until `projectPlans` says
 * otherwise; an SSH project never does.
 */
export function canHavePlans(project: Project): boolean {
  return !project.remote && !withoutPlans.has(project.projectPath);
}

/** A PR one of its sessions opened on GitHub: the project is a GitHub repository. */
function onGitHub(project: Project): boolean {
  return project.sessions.some(session => session.pullRequests?.some(pr => pr.repository));
}

/**
 * A project's plans (`closed`: open and closed together), or why there are
 * none to show. `projectPlans` answers null both for a project that is not a
 * GitHub repository and when `gh` could not be asked; a project known to be
 * on GitHub can only mean the second.
 */
export async function askProjectPlans(
  project: Project, closed: boolean,
): Promise<{ plans: PlanSummary[] } | { reason: string }> {
  const plans = await window.api.projectPlans(project.projectPath, { closed }).catch(() => null);
  if (plans) return { plans };
  if (onGitHub(project)) {
    return { reason: 'Couldn’t ask GitHub for this project’s plans. Install the GitHub CLI (gh) and run gh auth login.' };
  }
  withoutPlans.add(project.projectPath);
  return { reason: 'No plans: this project has no GitHub remote, or the GitHub CLI (gh) is missing or signed out.' };
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
