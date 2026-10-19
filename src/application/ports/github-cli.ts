/**
 * What GitHub says about a session's PRs and issues, through the user's own `gh`.
 *
 * Reads, plus the one kind of GitHub write Switchboard makes: your own review
 * (C3), because those are your words. Switchboard holds no token; `gh` signs
 * every request as the user.
 *
 * `gh` may be missing or signed out (D9), and the network may be down, so no
 * method throws. Each read answers null when it could not ask, and
 * `available()` says why; each write answers whether it went through.
 */
import type { GitHubAvailability, IssueStatus, PendingComment, PullRequestStatus } from '../../domain/session-work/model';
import type { ReviewEvent } from '../../domain/session-work/review';
import type { IssueKey, Plan, PlanSummary } from '../../domain/plan/model';

/** Whether `gh` can be asked anything: installed, and signed in to github.com. */
export type { GitHubAvailability };

export interface GitHubCli {
  available(): Promise<GitHubAvailability>;

  /**
   * The status of each of these PRs in `repo` (`owner/repo`), in one request.
   *
   * A number GitHub does not know is left out. Null when `gh` could not be
   * asked or the request failed.
   */
  pullRequests(repo: string, numbers: readonly number[]): Promise<PullRequestStatus[] | null>;

  /** The PR's unified diff, for a branch that is not checked out locally (D8). Null when unavailable. */
  pullRequestDiff(repo: string, number: number): Promise<string | null>;

  /**
   * The last `lines` lines of a check run's log, for the Fix CI prompt (W2).
   *
   * Only GitHub Actions keeps logs `gh` can read; any other check answers null.
   */
  checkLogTail(repo: string, checkRunUrl: string, lines: number): Promise<string | null>;

  /**
   * Which of these numbers are issues in `repo`, with their title and state.
   *
   * A number that is a PR, or that does not exist, is left out, which is how a
   * mention of `#88` that meant a PR drops out of the Issues group (D10). Null
   * when unavailable.
   */
  issues(repo: string, numbers: readonly number[]): Promise<IssueStatus[] | null>;

  // ── Plans (the Plan tab, #121): one GraphQL request each ──

  /**
   * Issue `number` in `repo` as a plan: its parent and its direct sub-issues
   * (the first 100), with their "Blocked by" links and closing PRs (P1, P4).
   * Blockers that are not sub-issues are `outside` (P5). Null when `gh` could
   * not be asked or the issue does not exist.
   */
  plan(repo: string, number: number): Promise<Plan | null>;

  /**
   * The plans in `repo`: issues that have sub-issues, and standalone
   * `ready-for-agent` issues. Open ones only, and closed ones too when
   * `closed` is set (W3, F3). The 50 most recently updated, newest first. Null
   * when unavailable.
   */
  plansIn(repo: string, options: { closed: boolean }): Promise<PlanSummary[] | null>;

  /**
   * The plan each of these issues belongs to, once each: its parent, or the
   * issue itself when it is a standalone `ready-for-agent` issue. An issue in
   * neither is left out. Null when unavailable.
   */
  plansOf(issues: readonly IssueKey[]): Promise<IssueKey[] | null>;

  /**
   * The issues each of these PRs in `repo` closes, by GitHub's closing
   * references (S1). A number GitHub does not know is left out. Null when
   * unavailable.
   */
  closingIssues(repo: string, numbers: readonly number[]): Promise<PullRequestCloses[] | null>;

  // ── Your review (C3): the only writes Switchboard makes to GitHub ──

  /** Start a pending review on a PR (by its GraphQL id), answering the review's id. */
  startPendingReview(pullRequestId: string): Promise<GitHubWrite<{ reviewId: string }>>;

  /** Add a line comment to a pending review, answering the thread GitHub made for it. */
  addPendingComment(reviewId: string, comment: NewLineComment): Promise<GitHubWrite<{ threadId: string }>>;

  /** Delete a pending review and every comment in it. */
  deletePendingReview(reviewId: string): Promise<GitHubWrite>;

  /** Submit a pending review as Request changes or as a comment. */
  submitPendingReview(reviewId: string, event: ReviewEvent): Promise<GitHubWrite>;
}

/** The reads the plan service makes. */
export type PlanReads = 'plan' | 'plansIn' | 'plansOf' | 'closingIssues';

/** A PR and the issues it closes. */
export interface PullRequestCloses {
  number: number;
  closes: IssueKey[];
}

/** A line comment to add: `line` on `side` of `path`, as GitHub anchors it. */
export type NewLineComment = Omit<PendingComment, 'threadId'>;

/** A write went through (with what GitHub answered), or did not, with GitHub's reason. */
export type GitHubWrite<T extends object = object> = ({ ok: true } & T) | { ok: false; reason: string };
