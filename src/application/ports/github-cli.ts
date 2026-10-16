/**
 * What GitHub says about a session's PRs and issues, through the user's own `gh`.
 *
 * Read-only: the one GitHub write Switchboard makes, your review (C3), is not
 * here yet. Switchboard holds no token; `gh` signs every request as the user.
 *
 * `gh` may be missing or signed out (D9), and the network may be down, so no
 * method throws. Each answers null when it could not ask, and `available()`
 * says why.
 */
import type { IssueStatus, PullRequestStatus } from '../../domain/session-work/model';

/** Whether `gh` can be asked anything: installed, and signed in to github.com. */
export type GitHubAvailability = 'ok' | 'missing' | 'unauthenticated';

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
}
