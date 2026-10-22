/**
 * The label every session row carries.
 *
 * The session list is flat — there are no directory headers left to stand in
 * for a project — so each row names its own. A worktree reads as
 * "parent ⎇ branch": its raw path ends in `.claude/worktrees/<name>`, which the
 * generic shortener would render as the useless "worktrees/<name>".
 */
import { shortProjectPath } from '../../../domain/project/project-path';

const WORKTREE_PATTERN = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;

export function projectLabel(projectPath: string | null | undefined): string {
  if (!projectPath) return '';
  const match = projectPath.match(WORKTREE_PATTERN);
  if (match) return shortProjectPath(match[1]) + ' ⎇ ' + match[2];
  return shortProjectPath(projectPath);
}

/** True for a project that is a git worktree of another one. */
export function isWorktreeProject(projectPath: string): boolean {
  return /\/\.claude\/worktrees\//.test(projectPath);
}

/** The repository a worktree project belongs to; any other project is its own. */
export function repositoryRoot(projectPath: string): string {
  return projectPath.match(WORKTREE_PATTERN)?.[1] ?? projectPath;
}

/** A worktree project's name (its folder under `.claude/worktrees`), or null for any other project. */
export function worktreeName(projectPath: string): string | null {
  return projectPath.match(WORKTREE_PATTERN)?.[2] ?? null;
}
