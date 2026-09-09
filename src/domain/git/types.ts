/**
 * What the git-facing parts of the app agree on.
 *
 * A project may be checked out in more than one place at once — `git worktree`
 * gives every branch its own directory sharing one repository — and the project
 * rail lets the session list be narrowed to one of those places. The types here
 * are the vocabulary for that: a parsed worktree, the scope a user has chosen,
 * and a git command described as data so the application layer can decide how
 * (and where) to run it.
 *
 * The second half is what changed in one of those places. It is split in two on
 * purpose — a summary that costs one cheap command for the whole tree, and the
 * hunks of a single file, bought only when someone opens it. A worktree where a
 * session has just regenerated a lockfile is 12,000 lines that nobody wants to
 * read and no process should have to carry across IPC to find that out.
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

// ── What changed ──

/**
 * One letter for what happened to a file.
 *
 * The same alphabet git uses, minus the spellings nothing here renders: `T`
 * (a file that became a symlink) reads as a modification, and `?` is ours for
 * a file git does not track yet. `U` is a conflict and stays its own letter all
 * the way to the surface — a conflicted file is not "modified", it is a file
 * the user has to decide about, and the diff surface draws it differently.
 */
export type FileStatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

/** A changed path, as `git status` and the summary side of `git diff` report it. */
export interface FileStatus {
  /** Relative to the worktree root, with forward slashes, exactly as git spells it. */
  path: string;
  status: FileStatusCode;
  /** Where a rename or copy came from. */
  oldPath?: string;
  /** The rename/copy score, 0–100. */
  similarity?: number;
}

/** One line of a hunk: what it is, and its text without the `+`/`-`/space. */
export interface HunkLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

/** One `@@ … @@` block. `header` is the whole line, section heading included. */
export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: HunkLine[];
}

/**
 * A changed file with everything the diff surface needs to draw it — except,
 * possibly, its hunks.
 *
 * `hunks` is empty for every file `GitService.changedFiles` reports, because
 * that phase buys sizes and never lines; `diffFile` fills them in for the one
 * file the user expanded. It is also empty for a binary file, which has no
 * lines to show at all.
 */
export interface FileDiff extends FileStatus {
  additions: number;
  deletions: number;
  binary: boolean;
  /** A lockfile, a build output, or `linguist-generated` in `.gitattributes`. */
  generated: boolean;
  /** Only ever true after `diffFile`: deciding it costs a second diff. */
  whitespaceOnly: boolean;
  /** A gitlink — the entry is a commit in another repository, not a file. */
  submodule: boolean;
  hunks: Hunk[];
  /**
   * Why this file's hunks are not here and should not be fetched unasked:
   * `'size'` for one past the oversize threshold, `'generated'` for a lockfile
   * or a build output. Both are still expandable — the UI hides them behind a
   * banner, it does not drop them.
   */
  truncated?: 'size' | 'generated';
  /** Which side of the diff ends without a final newline. */
  noNewlineAtEof?: 'old' | 'new' | 'both';
  /** e.g. `{ from: '100644', to: '100755' }` when a file gained the execute bit. */
  modeChange?: { from: string; to: string };
}

/**
 * What the diff is taken against.
 *
 * `branch` compares the working tree with a named ref; `merge-base` with the
 * point that ref and HEAD last shared, which is what "what has this branch
 * done" means; `uncommitted` with HEAD, which is everything not yet committed.
 * Only the last one always works, which is why it is the fallback.
 */
export type DiffBase =
  | { kind: 'branch'; ref: string }
  | { kind: 'merge-base'; ref: string }
  | { kind: 'uncommitted' };

/**
 * Every changed file, and the base it was really taken against.
 *
 * `base` and `requestedBase` differ whenever the asked-for base could not be
 * resolved — a branch that has been deleted, a detached HEAD with no branch
 * point. Invariant 7: fall back to uncommitted-only and *say so*, never guess a
 * base and present its diff as the truth. The surface shows `base`.
 *
 * `untracked` is beside `files` rather than in it because git's diff does not
 * know about files it does not track, so nothing here can say how many lines
 * one holds. The surface decides which of them to show — a file a session
 * created belongs in the list, the rest of the working tree does not.
 */
export interface DiffResult {
  base: DiffBase;
  requestedBase: DiffBase;
  files: FileDiff[];
  untracked: FileStatus[];
}

/** One record of `git diff --numstat -z`. */
export interface NumstatEntry {
  path: string;
  oldPath?: string;
  /** 0 for a binary file, which has no lines to count. */
  additions: number;
  deletions: number;
  binary: boolean;
}

/** One record of `git diff --raw -z`: what happened, and the modes it happened to. */
export interface RawDiffEntry {
  path: string;
  oldPath?: string;
  status: FileStatusCode;
  similarity?: number;
  /** Octal, as git prints it. `000000` means the file is absent on that side. */
  oldMode: string;
  newMode: string;
}

/**
 * The mode git gives a gitlink — an entry that is a commit in another
 * repository rather than a file. It turns up in the raw diff's mode columns and
 * in a patch's `index` line, and it is the only reliable way to tell a
 * submodule pointer from a one-line text file.
 */
export const SUBMODULE_MODE = '160000';

/** The `# branch.*` headers of `git status --porcelain=v2 --branch`. */
export interface StatusBranch {
  /** The HEAD sha, or null on a branch with no commits yet. */
  head: string | null;
  /** The branch name, or null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
}
