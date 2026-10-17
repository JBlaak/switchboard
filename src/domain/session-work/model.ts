/**
 * What a session has done to its repository, as the Session work page sees it.
 *
 * The page answers one question — what has this session done, where does it
 * stand, and what is the next move — so the model is the session's footprint
 * and nothing else: the PRs it opened, its branches that have no PR yet, the
 * worktrees it left uncommitted changes in, and the issues it talked about.
 * Everything here is plain data the main process assembles from the transcript,
 * git and `gh`, and the renderer draws; the rules that turn one into the other
 * live next to these types.
 */

/** A worktree and branch the session worked in, from a transcript line's `cwd` + `gitBranch`. */
export interface WorkLocation {
  /** The worktree root, not the `cwd` the line was written from. */
  worktree: string;
  branch: string;
  /** Only subagent transcripts went here; the main conversation never did. */
  fromSubagent: boolean;
}

/** A GitHub issue. `repository` is `owner/repo`, or '' when nothing said which. */
export interface IssueRef {
  repository: string;
  number: number;
}

/**
 * An issue `gh` confirmed is an issue, not a PR: a conversation names both as
 * `#88`, and only GitHub can tell them apart.
 */
export interface IssueStatus extends IssueRef {
  title: string;
  state: 'open' | 'closed';
  url: string;
}

/** One CI check on a PR's head commit, folded into the four states the page draws. */
export interface CheckRun {
  name: string;
  /** `failing` includes cancelled and timed out: either way someone has to act. */
  state: 'pending' | 'passing' | 'failing' | 'skipped';
  /** The run's page on GitHub, when `gh` gave one. */
  url?: string;
}

/** One comment in a review thread. */
export interface ThreadComment {
  author: string;
  /** Bots get a badge, and are never fixed automatically either (C4). */
  isBot: boolean;
  body: string;
  /** ISO-8601. */
  createdAt: string;
}

/** A review thread on a PR, from teammates, bots, or your own submitted review. */
export interface ReviewThread {
  /** GitHub's node id: what Claude replies to and resolves. */
  id: string;
  path: string;
  /** null when the thread is on the file, or its line is outdated. */
  line: number | null;
  side: DiffSide;
  resolved: boolean;
  /**
   * Claude replied and left it open because it needs your call (C5). Working
   * that out needs to know who "you" are on GitHub, so the adapter sets it.
   */
  needsYou?: boolean;
  /** Oldest first; the first one is what the thread asks for. */
  comments: ThreadComment[];
}

/** A line comment you have written but not yet submitted as a review. */
export interface PendingComment {
  path: string;
  line: number;
  side: DiffSide;
  body: string;
}

/**
 * A pull request the session opened, with whatever `gh` could add to it.
 *
 * The first three fields come from the transcript's `pr-link` line and are
 * always there; the rest only once `gh` answered, which it may never do — it
 * can be missing or signed out (D9) — so every one of them is optional and the
 * rules read an absent field as "unknown", never as "fine".
 */
export interface PullRequestStatus {
  number: number;
  url: string;
  repository: string;
  title?: string;
  state?: 'open' | 'draft' | 'merged' | 'closed';
  checks?: CheckRun[];
  /** Commits on the base branch the head does not have. */
  behindBy?: number;
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  threads?: ReviewThread[];
  pendingReview?: PendingComment[];
  /** Issues the PR closes, shown in its header (D10). */
  closes: IssueRef[];
  headRef?: string;
  headSha?: string;
  baseRef?: string;
}

/** The actions a work item can hand to Claude, each one a prompt (A1). */
export type WorkAction = 'ship' | 'rebase' | 'fix-ci' | 'fix-comments' | 'open-pr';

/** An action on a work item and how far it got. */
export interface Activity {
  action: WorkAction;
  /** `queued` waits for the session to go idle (A2); `sent` has been typed in. */
  phase: 'queued' | 'sent' | 'done' | 'gave-up';
  origin: 'manual' | 'auto';
  /** Which automatic Fix CI attempt this is, 1-based. */
  attempt?: number;
  /** ISO-8601. */
  queuedAt: string;
  /** ISO-8601. */
  sentAt?: string;
}

/**
 * Where a work item's diff comes from (D8): the local branch when it is
 * checked out, `gh pr diff` when it is not.
 */
export type DiffSource =
  | {
    kind: 'local';
    worktree: string;
    /** What the merge-base is taken against, e.g. `origin/main`. */
    base: string;
    head: string;
  }
  | { kind: 'pull-request'; repository: string; number: number };

/** How a file changed. `untracked` only occurs in a worktree's uncommitted changes. */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';

/** One uncommitted change in a worktree, from `git status`. */
export interface FileChange {
  path: string;
  /** Set for renames and copies. */
  oldPath?: string;
  status: FileStatus;
}

/**
 * One entry in the page's list.
 *
 * `error` is why part of the item could not be read — `gh` failed for its PR,
 * its diff could not be had. It belongs to the item, never to the page (one
 * bad PR does not blank the rest).
 */
export type WorkItem = { error?: string } & (
  | { kind: 'pr'; pr: PullRequestStatus; location: WorkLocation | null; diff: DiffSource; activity: Activity | null }
  | { kind: 'branch'; location: WorkLocation; ahead: number; diff: DiffSource; activity: Activity | null }
  | { kind: 'dirty'; location: WorkLocation; files: FileChange[] }
  /** An `IssueStatus` once `gh` confirmed it is an issue; a bare ref without `gh`. */
  | { kind: 'issue'; issue: IssueRef | IssueStatus }
);

/** Whether `gh` can be asked anything: installed, and signed in to github.com (D9). */
export type GitHubAvailability = 'ok' | 'missing' | 'unauthenticated';

/** A work item in a snapshot, with the id the page asks for its diff by (`workItemKey`). */
export type SessionWorkItem = WorkItem & { id: string };

/** Everything the page shows for one session, pushed whenever it changes. */
export interface SessionWorkSnapshot {
  sessionId: string;
  items: SessionWorkItem[];
  gh: GitHubAvailability;
  /** ISO-8601: when this snapshot was assembled. */
  updatedAt: string;
}

/** Which side of a diff a line, or a comment on it, belongs to — GitHub's names. */
export type DiffSide = 'LEFT' | 'RIGHT';

/** Why a file's diff starts collapsed (D7). */
export type CollapsedReason = 'lockfile' | 'generated' | 'large';

/** One line of a hunk. */
export interface DiffLine {
  kind: 'context' | 'add' | 'delete';
  /** Without the leading ` `, `+` or `-`. */
  text: string;
  /** The line's number in the old file; null for an added line. */
  oldLine: number | null;
  /** The line's number in the new file; null for a deleted line. */
  newLine: number | null;
  /** Followed by `\ No newline at end of file`. */
  noNewlineAtEnd?: boolean;
}

/** One `@@` hunk. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the closing `@@`, usually the enclosing function; '' when none. */
  section: string;
  lines: DiffLine[];
}

/** One file of a unified diff. */
export interface FileDiff {
  /** The new path; the old one for a deleted file. */
  path: string;
  /** Set for renames and copies. */
  oldPath?: string;
  status: Exclude<FileStatus, 'untracked'>;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Binary files are one row with no hunks, and cannot be commented on. */
  binary: boolean;
  collapsedReason?: CollapsedReason;
}
