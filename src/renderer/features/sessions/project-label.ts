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
