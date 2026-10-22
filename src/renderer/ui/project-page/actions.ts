/**
 * What the project page does (#173): opening it on a project, moving between
 * its views and closing it, and the header's and the Sessions section's
 * buttons. The components call these, never `window.api` or the store.
 */
import { dispatch, getState } from '../../state/app-store';
import { sessionMap, view } from '../../state/session-store';
import { relayoutSessionList } from '../session-list/relayout';
import { launchClaudeSession, openSession } from '../../features/sessions/session-actions';
import { projectLabel, repositoryRoot } from '../../features/sessions/project-label';
import { loadProjectSettings } from './settings-actions';
import { repositoryProjects } from './project-sessions';
import { encodeProjectPath } from '../../../domain/project/project-path';
import type { Project } from '../../../domain/project/project';

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
 * The project's settings, on its page (#176): the header's Settings button,
 * ⌘, on the page, and "Project settings" in the Projects modal's ⋯ menu. A
 * worktree opens its repository's, as its page does.
 */
export function openProjectSettings(projectPath: string): void {
  const repository = repositoryRoot(projectPath);
  dispatch({ type: 'projectOpened', projectPath: repository, view: { kind: 'settings' } });
  void loadProjectSettings(repository);
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
