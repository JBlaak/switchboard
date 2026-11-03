/**
 * What a project hand-off (#276 stage 2) needs from the Mac's git, and Bring
 * back's two writes.
 *
 * A port of its own rather than more methods on `GitWorkspace`: that port is
 * the Session work page's, read-only by promise (A1), and is also wired on the
 * agent. The hand-off is a Mac-only use case that makes temporary files (a
 * bundle, a temporary index) and, for Bring back, writes to the user's
 * repository; keeping it here keeps both promises visible.
 *
 * Every method answers rather than throws, like `GitWorkspace`. The user's own
 * index and working tree are never changed by any of the questions: the patch
 * is made against a temporary copy of the index.
 */
import type {GitWrite} from './git-workspace';

/** A file the hand-off uploads, read whole, with its SHA-256 (hex) for the agent to check. */
export interface HandoffArtifact {
    bytes: Uint8Array;
    sha256: string;
}

/** An ignored file read for the hand-off. */
export interface HandoffFileBytes {
    bytes: Uint8Array;
    /** POSIX permission bits, e.g. 0o600 for a `.env` kept private. */
    mode: number;
}

/**
 * How a Bring back worktree went. `taken` says the branch cannot be used here
 * as asked (it is checked out in another checkout, or has local commits origin
 * lacks), so the caller may try another branch name; other failures are
 * git's own and another name would not help.
 */
export type BringBackWorktree = {ok: true} | {ok: false; reason: string; taken: boolean};

export interface HandoffGit {
    /** The top of the checkout `cwd` is in; null outside a repository. */
    repositoryRoot(cwd: string): Promise<string | null>;

    /**
     * `git rev-parse --git-common-dir` in `cwd`, absolute: the main checkout's
     * `.git` for a linked worktree as much as for the main checkout itself.
     * A session hand-off (#276 stage 3) tells a worktree from the project's
     * own checkout by it. Null outside a repository.
     */
    commonDir(cwd: string): Promise<string | null>;

    /** The branch checked out; null on a detached HEAD. */
    currentBranch(root: string): Promise<string | null>;

    /** HEAD's commit id; null in a repository with no commits yet. */
    headOid(root: string): Promise<string | null>;

    /** `origin`'s URL; null when there is no such remote. */
    originUrl(root: string): Promise<string | null>;

    /** How many commits HEAD has that no `origin/*` ref has (`HEAD --not --remotes=origin`). */
    unpushedCount(root: string): Promise<number>;

    /**
     * A git bundle of `HEAD --not --remotes=origin`: the commits the VM's clone
     * of origin lacks, with HEAD as its one ref. Null when there are none (git
     * refuses an empty bundle) or it could not be made. Its temporary file is
     * gone by the time this answers.
     */
    bundle(root: string): Promise<HandoffArtifact | null>;

    /**
     * Every uncommitted change, staged, unstaged and untracked-but-not-ignored,
     * as one `git diff --binary` against HEAD, made through a temporary copy of
     * the index so the user's own staging is untouched. Null when the working
     * tree is clean.
     */
    patch(root: string): Promise<HandoffArtifact | null>;

    /** The paths with uncommitted changes, untracked files included, ignored ones not. */
    uncommittedPaths(root: string): Promise<string[]>;

    /**
     * The ignored paths as `git ls-files --others --ignored --exclude-standard
     * --directory` lists them: a wholly ignored folder once, with a trailing `/`.
     * Unfiltered; `isConfigCandidate` decides which are offered.
     */
    ignoredPaths(root: string): Promise<string[]>;

    /** The size of each of `paths` that is a regular file under `root` (never a symlink); the rest are left out. */
    fileSizes(root: string, paths: readonly string[]): Promise<Map<string, number>>;

    /** A regular file under `root`, never through a symlink; null otherwise. */
    readFile(root: string, path: string): Promise<HandoffFileBytes | null>;

    /**
     * Fetch `branch` straight from a VM copy, over the user's own ssh, into
     * `refs/remotes/<remote>/<branch>`. `remote` is added to the repository
     * (or pointed at `url` again) first. Nothing is pushed anywhere: Bring
     * back must not publish work the user has not pushed themselves.
     */
    fetchFromCopy(root: string, remote: string, url: string, branch: string): Promise<GitWrite>;

    /**
     * A worktree at `path` on the local branch `branch`, brought to `base` (a
     * remote-tracking ref such as `vm-buildbox/main`): created there when the
     * branch does not exist, fast-forwarded when it is behind and checked out
     * nowhere, or fast-forwarded in place when it is already checked out at
     * `path`. A branch checked out elsewhere, or with commits `base` lacks, is
     * `taken`. The branch gets no upstream; its first `git push -u origin`
     * gives it one.
     */
    addWorktree(root: string, path: string, branch: string, base: string): Promise<BringBackWorktree>;
}
