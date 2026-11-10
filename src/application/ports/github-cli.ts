/**
 * What GitHub says about a session's PRs and issues, through the user's own `gh`.
 *
 * Reads, plus the kinds of GitHub write Switchboard makes: your own review
 * (C3), because those are your words, the merge queue's own labels on a PR
 * (#315), because you asked to queue or retry it, and cancelling and re-running
 * Actions runs, because you asked to bump a job ahead of them. Switchboard holds no token;
 * `gh` signs every request as the user.
 *
 * `gh` may be missing or signed out (D9), and the network may be down, so no
 * method throws. Each read answers null when it could not ask, and
 * `available()` says why; each write answers whether it went through.
 */
import type {GitHubAvailability, IssueStatus, PendingComment, PullRequestStatus} from '../../domain/session-work/model';
import type {ReviewEvent} from '../../domain/session-work/review';
import type {IssueKey, Plan, PlanSummary} from '../../domain/plan/model';
import type {RepositoryIssue, RepositoryPullRequest} from '../../domain/project/overview';
import type {CiJob, Runner, TimedRun} from '../../domain/project/ci-job-queue';

/** Whether `gh` can be asked anything: installed, and signed in to github.com. */
export type {GitHubAvailability};

/**
 * Pull requests `pullRequestsIn` reads per repository: the 50 most recently
 * updated, unpaged. A repository that answers this many may have more.
 */
export const PULL_REQUESTS_PER_REPOSITORY = 50;

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
     * The last `lines` lines of a check run's log, for the Checks panel and the merge queue's fix prompt.
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
    plansIn(repo: string, options: {closed: boolean}): Promise<PlanSummary[] | null>;

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

    // ── The project page (#167): one GraphQL request each ──

    /**
     * The issues in `repo`, each with its labels, its parent and how many
     * sub-issues it has. Open ones only, and closed ones too when `closed` is
     * set. The 100 most recently updated, newest first. Null when unavailable.
     */
    issuesIn(repo: string, options: {closed: boolean}): Promise<RepositoryIssue[] | null>;

    /**
     * The pull requests in `repo`, each with its checks taken together, its
     * review decision and the issues it closes, and what the merge queue reads
     * of it (#315: base, labels, `automerge` status, reviewers, check runs).
     * Open ones only, and merged ones too when `merged` is set. The 50 most
     * recently updated, newest first. Null when unavailable.
     */
    pullRequestsIn(repo: string, options: {merged: boolean}): Promise<RepositoryPullRequest[] | null>;

    /**
     * How long the last 20 green runs of `repo`'s CI workflow took, ms, newest
     * first: one CI run in the merge queue's estimates (#315). Empty when it
     * has none; null when unavailable.
     */
    ciRunDurations(repo: string): Promise<number[] | null>;

    // ── The merge queue's labels (#315): only `automerge:opt-in` added, `automerge:failed` removed ──

    /** Add `label` to PR (or issue) `number` in `repo`. */
    addLabel(repo: string, number: number, label: string): Promise<GitHubWrite>;

    /** Remove `label` from PR (or issue) `number` in `repo`. */
    removeLabel(repo: string, number: number, label: string): Promise<GitHubWrite>;

    // ── The CI job queue under the merge queue: its reads, and a Bump's two run writes ──

    /**
     * The self-hosted runners that serve `repo`: its own and its owner's
     * organisation's, each read when the token may (both need admin rights).
     * Null when neither could be read.
     */
    selfHostedRunners(repo: string): Promise<Runner[] | null>;

    /**
     * The running and queued jobs of `repo`'s unfinished Actions runs (among
     * its newest 50), each with the open PR whose branch it runs on. Null when
     * unavailable.
     */
    ciJobs(repo: string): Promise<CiJob[] | null>;

    /** The ids of the newest `count` successful runs of workflow `workflowId`, newest first. Null when unavailable. */
    successfulRuns(repo: string, workflowId: number, count: number): Promise<number[] | null>;

    /** How long each succeeded job of run `runId` ran; null when unavailable or none succeeded. */
    runJobTimes(repo: string, runId: number, workflowId: number): Promise<TimedRun | null>;

    /** Whether run `runId` has stopped (completed, whatever its conclusion); null when unavailable. */
    runCompleted(repo: string, runId: number): Promise<boolean | null>;

    /** Cancel run `runId`, every job in it. */
    cancelRun(repo: string, runId: number): Promise<GitHubWrite>;

    /** Re-run run `runId`'s failed and cancelled jobs. */
    rerunFailedJobs(repo: string, runId: number): Promise<GitHubWrite>;

    // ── Your review (C3): with the queue's labels, the only writes Switchboard makes to GitHub ──

    /** Start a pending review on a PR (by its GraphQL id), answering the review's id. */
    startPendingReview(pullRequestId: string): Promise<GitHubWrite<{reviewId: string}>>;

    /** Add a line comment to a pending review, answering the thread GitHub made for it. */
    addPendingComment(reviewId: string, comment: NewLineComment): Promise<GitHubWrite<{threadId: string}>>;

    /** Delete a pending review and every comment in it. */
    deletePendingReview(reviewId: string): Promise<GitHubWrite>;

    /** Submit a pending review as Request changes or as a comment. */
    submitPendingReview(reviewId: string, event: ReviewEvent): Promise<GitHubWrite>;
}

/** The reads the plan service makes. */
export type PlanReads = 'plan' | 'plansIn' | 'plansOf' | 'closingIssues';

/** The reads the project page makes. */
export type ProjectReads = 'issuesIn' | 'pullRequestsIn' | 'ciRunDurations';

/** The merge queue's label writes (#315). */
export type QueueLabelWrites = 'addLabel' | 'removeLabel';

/** What the CI job queue reads and a Bump writes. */
export type CiJobQueueCalls =
    | 'selfHostedRunners'
    | 'ciJobs'
    | 'successfulRuns'
    | 'runJobTimes'
    | 'runCompleted'
    | 'cancelRun'
    | 'rerunFailedJobs';

/** A PR and the issues it closes. */
export interface PullRequestCloses {
    number: number;
    closes: IssueKey[];
}

/** A line comment to add: `line` on `side` of `path`, as GitHub anchors it. */
export type NewLineComment = Omit<PendingComment, 'threadId'>;

/** A write went through (with what GitHub answered), or did not, with GitHub's reason. */
export type GitHubWrite<T extends object = object> = ({ok: true} & T) | {ok: false; reason: string};
