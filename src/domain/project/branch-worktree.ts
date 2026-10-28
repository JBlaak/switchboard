/**
 * A worktree made for a new session on a branch of its own: an issue's (A2)
 * or a task's (#244). What both starts share, without git.
 */

/** How many of a title's words name its branch. */
const SLUG_WORDS = 5;

/**
 * The first few words of `title`, lower case, accents dropped, joined with
 * `-`; '' when it has no letters or digits.
 */
export function titleSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, SLUG_WORDS)
    .join('-');
}

/**
 * What to do when a new session's branch exists already: `replace` deletes
 * its worktree (changes and all) and the branch, then starts afresh; `reuse`
 * starts in its worktree, adding one for the branch when it has none.
 */
export type ExistingBranchChoice = 'replace' | 'reuse';

/** The branch a new session would start on exists already: where, and what is on it. */
export interface ExistingBranch {
  branch: string;
  /** The checkout it is in; null when no worktree has it checked out. */
  worktreePath: string | null;
  /** It is checked out in the repository's main checkout, which is never deleted. */
  main: boolean;
  /** Uncommitted changes in its worktree, untracked files included. */
  changedFiles: number;
  /** Commits on it that the default branch lacks; 0 when it has no worktree to ask. */
  ahead: number;
  /** The session that worked in its worktree or on it most recently, archived ones included; null when none did. */
  sessionId: string | null;
}
