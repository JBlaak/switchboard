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

/** A line comment to add: `line` on `side` of `path`, as GitHub anchors it. */
export type NewLineComment = Omit<PendingComment, 'threadId'>;

/** A write went through (with what GitHub answered), or did not, with GitHub's reason. */
export type GitHubWrite<T extends object = object> = ({ ok: true } & T) | { ok: false; reason: string };
