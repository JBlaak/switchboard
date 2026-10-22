/**
 * What the project page does (#173): opening it on a project, moving between
 * its views and closing it, the header's and the Sessions section's buttons,
 * and (#174) asking for the project's overview and the Plans & issues
 * section's actions, and (#175) the Pull requests and Worktrees sections' and
 * the GitHub message's. The components call these, never `window.api` or the store.
 */
import { dispatch, getState } from '../../state/app-store';
import { sessionMap, view } from '../../state/session-store';
import { relayoutSessionList } from '../session-list/relayout';
import { launchClaudeSession, openSession, startClaudeSessionIn } from '../../features/sessions/session-actions';
import { resolveDefaultSessionOptions } from '../../features/dialogs/launch-options';
import { projectLabel, repositoryRoot } from '../../features/sessions/project-label';
import { openSettings } from '../settings/actions';
import { repositoryProjects } from './project-sessions';
import { encodeProjectPath } from '../../../domain/project/project-path';
import type { Project } from '../../../domain/project/project';
import { issueKeyString } from '../../../domain/plan/model';
import type { IssueKey } from '../../../domain/plan/model';
import type { IssueSessionStart } from '../../../domain/plan/issue-session';
import { openPlanPage } from '../plan-page/actions';
import { startIssueSession } from '../session-work/plan/actions';
import { pulseSessionRow } from '../session-list/pulse';
import { cursorId } from './page-rows';
import { AUTH_COMMAND } from './page-state';

/** True for an ssh:// project: no GitHub link, nothing local to read. */
export function isRemoteProject(projectPath: string): boolean {
  return projectPath.startsWith('ssh://');
}

/**
 * Open a project's page on its overview. A worktree opens its repository's
 * page. The session on screen stays the one Esc goes back to.
 */
export function openProjectPage(projectPath: string): void {
  dispatch({ type: 'projectOpened', projectPath: repositoryRoot(projectPath), view: { kind: 'overview' } });
}

/** From a plan (or the settings) inside the page back to its overview: the breadcrumb, ⌘[. */
export function backToProject(): void {
  const { route } = getState().mainArea;
  if (route.kind !== 'project' || route.view.kind === 'overview') return;
  dispatch({ type: 'projectOpened', projectPath: route.projectPath, view: { kind: 'overview' } });
}

/** Close the project: the session it covered comes back, focused, or the empty screen. */
export function closeProject(): void {
  dispatch({ type: 'projectClosed' });
}

/** The project's repository on GitHub, in the browser. Nothing for a remote project. */
export function openProjectOnGitHub(projectPath: string): void {
  if (isRemoteProject(projectPath)) return;
  void window.api.openRepository(projectPath);
}

/**
 * A click on a project's name, wherever it is shown: the page, or GitHub
 * with ⌘ held (nothing for a remote project, which has no GitHub link).
 */
export function clickProjectName(projectPath: string, withCommand: boolean): void {
  if (withCommand) openProjectOnGitHub(projectPath);
  else openProjectPage(projectPath);
}

/** New session: a session in this project, launched and put on screen the usual way. */
export function startProjectSession(projectPath: string): void {
  void launchClaudeSession(cachedProject(projectPath));
}

/**
 * The header's Settings button. For now the project's settings in the
 * settings panel, as the picker's gear opens them; #176 moves them onto the
 * page as `project → settings`.
 */
export function openProjectSettings(projectPath: string): void {
  void openSettings('project', projectPath);
}

/** Open one of the project's sessions, the way its sidebar row does; the page gives way. */
export function openProjectSession(sessionId: string): void {
  const session = sessionMap.get(sessionId);
  if (session) void openSession(session);
}

/**
 * Show all: the sidebar filtered to the project and its worktrees, with the
 * project's name in the search box. Archived sessions are included, as in any
 * search; editing the box searches as usual.
 */
export function showProjectInSidebar(projectPath: string): void {
  const paths = repositoryProjects(view.cachedAllProjects, projectPath).map(p => p.projectPath);
  dispatch({ type: 'searchTyped', query: projectLabel(projectPath) });
  dispatch({ type: 'searchMatched', ids: new Set(), projectPaths: new Set([projectPath, ...paths]) });
  relayoutSessionList({ resort: true });
}

/** The cached project at `projectPath`, or one made up from the path when the cache has none yet. */
function cachedProject(projectPath: string): Project {
  return view.cachedAllProjects.find(p => p.projectPath === projectPath)
    ?? { projectPath, folder: encodeProjectPath(projectPath), sessions: [], remote: isRemoteProject(projectPath) };
}

// ── Plans & issues (#174) ──

/**
 * Ask main for the project's overview, closed plans and merged pull requests
 * included or not, and keep the answer. A failed call keeps what the page
 * had: the next poll asks again.
 */
export async function loadProjectOverview(projectPath: string, closed: boolean, merged: boolean): Promise<void> {
  try {
    const overview = await window.api.projectOverview(projectPath, { closed, merged });
    dispatch({ type: 'projectOverviewAnswered', projectPath, closed, merged, overview });
  } catch {
    // Main could not answer at all; the section stays as it was.
  }
}

/** Ask again now, for whatever the page shows: after a session started from it, say. */
export function reloadProjectOverview(): void {
  const { projectPath, showClosed, showMerged } = getState().projectPage;
  if (projectPath) void loadProjectOverview(projectPath, showClosed, showMerged);
}

/** A plan row's click or ↵: the plan inside the page. */
export function openProjectPlan(projectPath: string, plan: IssueKey): void {
  openPlanPage({ projectPath, repository: plan.repository, number: plan.number });
}

/** An issue's ↵: the issue on GitHub. */
export function openIssueOnGitHub(issue: IssueKey): void {
  void window.api.openExternal(`https://github.com/${issue.repository}/issues/${issue.number}`);
}

/**
 * Start session on an issue in one of the project's plans: a worktree for it
 * and a session there, the way the Plan view starts one, without leaving the
 * page. Its new sidebar row pulses once instead, and the overview is asked
 * again so the row shows its session.
 */
export async function startPageIssueSession(projectPath: string, issue: IssueKey, plan: IssueKey): Promise<void> {
  const key = issueKeyString(issue);
  if (getState().projectPage.start?.phase === 'starting') return;
  dispatch({ type: 'projectIssueStartAsked', issue: key });
  const result = await startOn(projectPath, issue, plan);
  if (result.ok) pulseSessionRow(result.sessionId);
  dispatch({ type: 'projectIssueStartAnswered', issue: key, result });
  if (result.ok) reloadProjectOverview();
}

// ── Pull requests, worktrees and the edge states (#175) ──

/** A PR row's click or ↵: the pull request on GitHub. */
export function openPullRequestOnGitHub(pullRequest: IssueKey): void {
  void window.api.openExternal(`https://github.com/${pullRequest.repository}/pull/${pullRequest.number}`);
}

/** A PR's "in #n" chip: that plan expanded in place, with the cursor on it. */
export function revealPlan(plan: IssueKey): void {
  dispatch({ type: 'projectPlanExpanded', plan: issueKeyString(plan) });
  dispatch({ type: 'projectCursorMoved', target: cursorId.plan(plan) });
}

/** Copy command: the command that signs `gh` in, on the clipboard. */
export function copyAuthCommand(): void {
  void window.api.writeClipboard(AUTH_COMMAND);
}

/**
 * Start session in one of the project's worktrees: Claude started there with
 * the project's usual options, minus `--worktree` (it is in one already),
 * without leaving the page. Its new sidebar row pulses once instead, and the
 * overview is asked again so the worktree shows its session.
 */
export async function startWorktreeSession(projectPath: string, path: string): Promise<void> {
  if (getState().projectPage.worktreeStart?.phase === 'starting') return;
  dispatch({ type: 'projectWorktreeStartAsked', path });
  let result: { ok: true; sessionId: string } | { ok: false; reason: string };
  try {
    const { worktree: _worktree, worktreeName: _worktreeName, ...options } = await resolveDefaultSessionOptions(projectPath);
    result = await startClaudeSessionIn(path, options, { show: false });
  } catch (err) {
    result = { ok: false, reason: (err as Error).message || 'Could not start the session' };
  }
  if (result.ok) pulseSessionRow(result.sessionId);
  dispatch({ type: 'projectWorktreeStartAnswered', path, result });
  if (result.ok) reloadProjectOverview();
}

async function startOn(projectPath: string, issue: IssueKey, planKey: IssueKey): Promise<IssueSessionStart> {
  try {
    // The whole plan, which says what the issue stacks on; PlanService has it cached.
    const plan = await window.api.plan(planKey.repository, planKey.number);
    if (!plan) return { ok: false, reason: `Could not read plan #${planKey.number}` };
    return await startIssueSession({ projectPath, issue, plan, show: false });
  } catch (err) {
    return { ok: false, reason: (err as Error).message || 'Could not start the session' };
  }
}
