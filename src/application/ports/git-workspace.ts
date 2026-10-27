/**
 * What git knows about the worktrees a session worked in, read-only.
 *
 * The Session work page shows a session's branches and uncommitted changes and
 * the diffs behind them (D5, D8). Switchboard never writes to git itself (A1),
 * so nothing here changes a repository: every method is a question.
 *
 * Every method answers rather than throws. A worktree that has gone, a branch
 * that was deleted, a repository with no commits yet — each is an ordinary
 * state of a session's footprint, and answers with the empty value.
 *
 * `GitWorktrees`, at the end, is the one exception to "only questions":
 * starting a session on a plan's issue (A2) fetches the branch it starts from
 * and adds a worktree for it, because the user asked for exactly that;
 * when its branch exists already, the user may ask to continue on it or to
 * delete it and start afresh; and archiving a session removes the worktrees
 * it worked in, when the user has switched that on.
 */
import type { FileChange, LineStats } from '../../domain/session-work/model';
import type { WorktreeSummary } from '../../domain/project/overview';

/** Something to stop. */
export interface Disposable {
  dispose(): void;
}

export interface GitWorkspace {
  /** The root of the worktree `cwd` sits in, or null when it is in none. */
  worktreeRoot(cwd: string): Promise<string | null>;

  /**
   * The repository's default branch name, e.g. `main` — not `origin/main`.
   *
   * Read from `origin/HEAD`; when that is not set, `main` or `master`,
   * whichever exists, and `main` when neither does.
   */
  defaultBranch(worktree: string): Promise<string>;

  /** The branch checked out in the worktree now; null on a detached HEAD or when it is gone. */
  currentBranch(worktree: string): Promise<string | null>;

  /**
   * The commit `ref` points at, or null when it does not resolve. What a
   * diff is cached against: the same commits make the same diff.
   */
  commitSha(worktree: string, ref: string): Promise<string | null>;

  /** Does `branch` exist as a local branch? */
  branchExists(worktree: string, branch: string): Promise<boolean>;

  /** Has `branch` been pushed: does it have an upstream, or a branch of the same name on origin? */
  isPushed(worktree: string, branch: string): Promise<boolean>;

  /** Commits on `branch` that `base` lacks (`ahead`), and the reverse (`behind`). Zeros when either is unknown. */
  aheadBehind(worktree: string, branch: string, base: string): Promise<{ ahead: number; behind: number }>;

  /** The unified diff of `branch` against its merge-base with `base`; '' when either is unknown. */
  branchDiff(worktree: string, branch: string, base: string): Promise<string>;

  /** Lines `branch` adds and removes since its merge-base with `base`; zeros when either is unknown. */
  branchLineStats(worktree: string, branch: string, base: string): Promise<LineStats>;

  /** The worktree's uncommitted changes, untracked files included. */
  status(worktree: string): Promise<FileChange[]>;

  /** Staged, unstaged and untracked changes as one unified diff against HEAD; untracked files appear as new files. */
  workingDiff(worktree: string): Promise<string>;

  /** Lines the uncommitted changes add and remove, counted the way `workingDiff` shows them. */
  workingLineStats(worktree: string): Promise<LineStats>;

  /** The commit a diff of `branch` against `base` starts from; null when either is unknown. */
  mergeBase(worktree: string, branch: string, base: string): Promise<string | null>;

  /**
   * The size in bytes of each of `paths` at `revision`, asked in one go. A
   * path that is not there at that revision is left out.
   */
  blobSizes(worktree: string, revision: string, paths: readonly string[]): Promise<Map<string, number>>;

  /** The bytes of `path` at `revision`, untouched by any filter; null when it is not there. */
  blob(worktree: string, revision: string, path: string): Promise<Uint8Array | null>;

  /** The size in bytes of each of `paths` in the working tree; a path that is not a file there is left out. */
  workingFileSizes(worktree: string, paths: readonly string[]): Promise<Map<string, number>>;

  /**
   * The bytes of `path` in the working tree; null when it is not a file
   * there. Never reads outside the worktree, nor through a symlink.
   */
  workingFile(worktree: string, path: string): Promise<Uint8Array | null>;

  /**
   * The ones among `paths` that `.gitattributes` marks `linguist-generated`,
   * for the diff parser's collapse rule (D7).
   */
  generatedPaths(worktree: string, paths: readonly string[]): Promise<string[]>;

  /**
   * Every checkout of the repository at `repository`, the main one first, for
   * the project page (#167): its branch, how many files it has changed, how
   * many commits it is ahead of the default branch (`origin`'s when there is
   * one) and whether its branch is merged into it. A bare main repository has
   * no checkout and a worktree whose directory has gone cannot be read, so
   * both are left out. Empty outside a repository.
   */
  worktrees(repository: string): Promise<WorktreeSummary[]>;

  /**
   * Call `onChange` when the worktree's HEAD, index or refs change: a commit,
   * a checkout, a rebase, a `git add`. Bursts are coalesced into one call.
   * Edits to working files that nothing has staged are not reported.
   */
  watch(worktree: string, onChange: () => void): Disposable;
}

/** A git write went through, or did not, with git's reason. */
export type GitWrite = { ok: true } | { ok: false; reason: string };

/**
 * The worktree a session on a plan's issue starts in (A2, A3), and its removal
 * once the session is archived. Writes, and only these: a fetch of the branch
 * it starts from, the worktree itself, and taking the worktree away again.
 */
export interface GitWorktrees {
  /**
   * The main checkout of the repository `cwd` is in: for a linked worktree,
   * the checkout it was added from. Null outside a repository.
   */
  mainCheckout(cwd: string): Promise<string | null>;

  /** Fetch `branch` from origin into `origin/<branch>`. */
  fetchBranch(repository: string, branch: string): Promise<GitWrite>;

  /**
   * `git worktree add -b <branch> <path> <base>`, the new branch tracking
   * nothing, so it only counts as pushed once it has been.
   */
  addWorktree(repository: string, path: string, branch: string, base: string): Promise<GitWrite>;

  /** `git worktree add <path> <branch>`: a worktree on a branch that exists already. */
  checkoutWorktree(repository: string, path: string, branch: string): Promise<GitWrite>;

  /**
   * `git worktree remove <path>`: git refuses a worktree with uncommitted or
   * untracked changes, or a locked one, and says why, unless `force` (asked
   * for only when the user chose to throw those changes away). Its branch is
   * kept. Files `.gitignore` covers go with the directory.
   */
  removeWorktree(repository: string, path: string, options?: { force?: boolean }): Promise<GitWrite>;

  /** `git worktree prune`: forget worktrees whose directory has gone, so their branch is free again. */
  pruneWorktrees(repository: string): Promise<GitWrite>;

  /** `git branch -D <branch>`: deleted whether merged or not. */
  deleteBranch(repository: string, branch: string): Promise<GitWrite>;
}
