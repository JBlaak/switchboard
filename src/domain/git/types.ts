/**
 * What the git-facing parts of the app agree on.
 *
 * A project may be checked out in more than one place at once — `git worktree`
 * gives every branch its own directory sharing one repository — and the project
 * rail lets the session list be narrowed to one of those places. The types here
 * are the vocabulary for that: a parsed worktree, the scope a user has chosen,
 * and a git command described as data so the application layer can decide how
 * (and where) to run it.
 */

/** One entry of `git worktree list --porcelain`, after parsing. */
export interface Worktree {
  /** Absolute, no trailing slash. */
  path: string;
  /** Full sha. */
  head: string;
  /** 'feat/x' (refs/heads/ stripped), null when detached. */
  branch: string | null;
  /** The first entry git prints — the main working tree. */
  isPrimary: boolean;
  detached: boolean;
  /** The lock reason; '' when locked without one; absent when not locked. */
  locked?: string;
}

/**
 * What the session list is narrowed to. `worktreePath` null means the whole
 * project including every worktree; set, it names one checkout.
 */
export interface Scope {
  projectPath: string;
  worktreePath: string | null;
}

/** A git command as data: what to spawn and with which arguments. */
export interface GitInvocation {
  file: string;
  args: string[];
}
