/**
 * The user's own `gh` behind the GitHubCli port.
 *
 * `gh` signs every request with the account the user logged in with, so
 * Switchboard never sees or stores a token, and whatever the user can see on
 * GitHub, the page can.
 *
 * All of a repository's PRs come back from one GraphQL request (W1 polls every
 * open PR every minute; one request per PR would spend the rate limit fast):
 * one aliased `pullRequest(number:)` field per PR. The same request asks who
 * the viewer is, because a review thread "needs you" when Claude — posting as
 * you — had the last word and left it open (C5).
 *
 * The writes are your review's (C3): a pending review, its comments, and
 * submitting or deleting it, each a GraphQL mutation whose values all travel
 * as variables; and the merge queue's labels on a PR (#315), added or removed
 * through the REST API, the label in the request body or escaped in its path.
 *
 * Every command is `execFile('gh', argv)`, never a shell string. The runner is
 * injected so the tests can feed recorded responses without `gh` installed.
 */
import {execFile} from 'node:child_process';
import type {
    BranchUpdate,
    GitHubAvailability,
    GitHubCli,
    GitHubWrite,
    MergeAnswer,
    NewLineComment,
} from '../../application/ports/github-cli';
import type {PullRequestCloses} from '../../application/ports/github-cli';
import type {IssueKey, Plan, PlanSummary} from '../../domain/plan/model';
import {
    PLANS_QUERY,
    closingIssuesQuery,
    planQuery,
    plansOfQuery,
    plansSearch,
    toClosingIssues,
    toPlan,
    toPlanSummaries,
    toPlansOf,
} from './gh-plans';
import {
    ciRunsArgs,
    issuesQuery,
    pullRequestsInQuery,
    toCiRunDurations,
    toRepositoryIssues,
    toRepositoryPullRequests,
} from './gh-overview';
import type {RepositoryIssue, RepositoryPullRequest} from '../../domain/project/overview';
import {LATEST_TAG_QUERY, RECENT_TAGS_QUERY, toLatestTag, toTags} from './gh-tags';
import {toCheck} from './gh-checks';
import {BRANCH_PULL_REQUEST_QUERY, toBranchPullRequest} from './gh-branch-pr';
import {INBOX_ISSUES_QUERY, ISSUE_THREAD_QUERY, toInboxIssues, toIssueThread} from './gh-inbox';
import type {IssueThread} from '../../domain/inbox/issue-manager';
import {
    QUEUED_PULL_REQUESTS_QUERY,
    QUEUED_SEARCH,
    UPDATE_BRANCH_MUTATION,
    WORKFLOWS_QUERY,
    httpStatus,
    lanePaths,
    laneQuery,
    toLaneRead,
    toBranchUpdateFailure,
    toQueuedPullRequests,
    toWorkflowFiles,
} from './gh-lanes';
import type {LaneRead, MergeMethod, WorkflowFile} from '../../domain/merge-manager/model';
import type {InboxIssuesAnswer} from '../../domain/inbox/loose-issues';
import type {BranchPullRequest} from '../../domain/inbox/stage';
import type {CiJob, Runner, TimedRun} from '../../domain/project/ci-job-queue';
import {ciJobPaths, toActiveRuns, toCiJobs, toRunCompleted, toRunIds, toRunners, toTimedRun} from './gh-ci-jobs';
import type {ReviewEvent} from '../../domain/session-work/review';
import type {
    DiffSide,
    IssueRef,
    IssueStatus,
    PendingComment,
    PullRequestStatus,
    ReviewThread,
    ThreadComment,
} from '../../domain/session-work/model';

/** What running `gh` produced. `missing` when the binary could not be started at all. */
export interface GhResult {
    missing: boolean;
    /** null when it was killed (a timeout) or never started. */
    code: number | null;
    stdout: string;
    stderr: string;
}

export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

export interface GhCliOptions {
    /** Defaults to running the `gh` on `env`'s PATH. */
    run?: GhRunner;
    /**
     * The environment `gh` runs in. An app started from the Finder does not
     * get the login shell's PATH, so the caller passes one that finds `gh`.
     */
    env?: NodeJS.ProcessEnv;
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** `owner/repo`, both parts in GitHub's own alphabet. */
const REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

/** An Actions job's page, `…/actions/runs/<run>/job/<job>`, or a check run's, `…/runs/<id>`. */
const ACTIONS_JOB_URL = /\/actions\/runs\/\d+\/jobs?\/(\d+)/;
const CHECK_RUN_URL = /\/runs\/(\d+)(?:[/?#]|$)/;

export function defaultGhRunner(env: NodeJS.ProcessEnv = process.env): GhRunner {
    return (args) =>
        new Promise((resolve) => {
            execFile(
                'gh',
                [...args],
                {
                    timeout: TIMEOUT_MS,
                    maxBuffer: MAX_OUTPUT_BYTES,
                    encoding: 'utf8',
                    // Plain output, and no prompt that could hang a background poll.
                    env: {...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1'},
                },
                (err, stdout, stderr) => {
                    const errCode = (err as {code?: unknown} | null)?.code;
                    resolve({
                        missing: errCode === 'ENOENT',
                        code: err ? (typeof errCode === 'number' ? errCode : null) : 0,
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                    });
                },
            );
        });
}

/**
 * Did `gh` fail because nobody is signed in?
 *
 * `gh` exits 4 when a command needs a login it does not have; a token that
 * was revoked fails the request itself with a 401.
 */
function isAuthFailure(result: GhResult): boolean {
    return result.code === 4 || /HTTP 401|Bad credentials|gh auth login|not logged in/i.test(result.stderr);
}

export class GhCli implements GitHubCli {
    private readonly run: GhRunner;

    constructor(options: GhCliOptions = {}) {
        this.run = options.run ?? defaultGhRunner(options.env);
    }

    public async available(): Promise<GitHubAvailability> {
        const result = await this.run(['auth', 'status', '--hostname', 'github.com']);
        if (result.missing) return 'missing';
        if (result.code === 0) return 'ok';
        return 'unauthenticated';
    }

    public async pullRequests(repo: string, numbers: readonly number[]): Promise<PullRequestStatus[] | null> {
        const wanted = validNumbers(numbers);
        const parts = REPO.exec(repo);
        if (!parts) return null;
        if (wanted.length === 0) return [];

        const data = await this.graphql(pullRequestsQuery(wanted), {owner: parts[1], name: parts[2]});
        if (!data) return null;
        const viewer = typeof data.viewer?.login === 'string' ? data.viewer.login : '';
        const repository = data.repository;
        if (!repository) return null;

        const found: PullRequestStatus[] = [];
        for (const number of wanted) {
            const node = repository['pr' + number];
            if (node) found.push(toPullRequest(node, repo, viewer));
        }
        return found;
    }

    public async pullRequestDiff(repo: string, number: number): Promise<string | null> {
        if (!REPO.test(repo) || validNumbers([number]).length === 0) return null;
        const result = await this.run(['pr', 'diff', String(number), '--repo', repo, '--color', 'never']);
        return result.code === 0 ? result.stdout : null;
    }

    public async checkLogTail(repo: string, checkRunUrl: string, lines: number): Promise<string | null> {
        if (!REPO.test(repo)) return null;
        const job = ACTIONS_JOB_URL.exec(checkRunUrl) ?? CHECK_RUN_URL.exec(checkRunUrl);
        if (!job) return null;
        // The failed steps' log ends where it went wrong; the whole job's ends
        // with the runner cleaning up. A job with no failed step (cancelled, or
        // still running) only has the whole log.
        for (const which of ['--log-failed', '--log']) {
            const result = await this.run(['run', 'view', '--repo', repo, '--job', job[1], which]);
            if (result.missing || isAuthFailure(result)) return null;
            if (result.code === 0 && result.stdout.trim())
                return tail(result.stdout.split('\n').map(stripLogPrefix), lines);
        }
        return null;
    }

    public async issues(repo: string, numbers: readonly number[]): Promise<IssueStatus[] | null> {
        const wanted = validNumbers(numbers);
        const parts = REPO.exec(repo);
        if (!parts) return null;
        if (wanted.length === 0) return [];

        const fields = wanted.map(
            (number) =>
                `i${number}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { number title state url } }`,
        );
        const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
        const data = await this.graphql(query, {owner: parts[1], name: parts[2]});
        if (!data?.repository) return null;

        const found: IssueStatus[] = [];
        for (const number of wanted) {
            const node = data.repository['i' + number];
            // A PR answers as a PullRequest; a number that is neither answers null.
            if (node?.__typename !== 'Issue') continue;
            found.push({
                repository: repo,
                number: node.number,
                title: node.title ?? '',
                state: node.state === 'OPEN' ? 'open' : 'closed',
                url: node.url ?? `https://github.com/${repo}/issues/${number}`,
            });
        }
        return found;
    }

    // ── Plans (#121): the queries and their mapping are in `gh-plans.ts` ──

    public async plan(repo: string, number: number): Promise<Plan | null> {
        const parts = REPO.exec(repo);
        if (!parts || validNumbers([number]).length === 0) return null;
        const data = await this.graphql(planQuery(number), {owner: parts[1], name: parts[2]});
        return data ? toPlan(data, repo) : null;
    }

    public async plansIn(repo: string, options: {closed: boolean}): Promise<PlanSummary[] | null> {
        if (!REPO.test(repo)) return null;
        const data = await this.graphql(PLANS_QUERY, {search: plansSearch(repo, options.closed === true)});
        return data ? toPlanSummaries(data, repo) : null;
    }

    public async plansOf(issues: readonly IssueKey[]): Promise<IssueKey[] | null> {
        const seen = new Set<string>();
        const wanted = issues.filter((issue) => {
            const key = issue.repository + '#' + issue.number;
            if (!REPO.test(issue.repository) || validNumbers([issue.number]).length === 0 || seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        if (wanted.length === 0) return [];
        const data = await this.graphql(plansOfQuery(wanted), {});
        return data ? toPlansOf(data, wanted) : null;
    }

    public async closingIssues(repo: string, numbers: readonly number[]): Promise<PullRequestCloses[] | null> {
        const wanted = validNumbers(numbers);
        const parts = REPO.exec(repo);
        if (!parts) return null;
        if (wanted.length === 0) return [];
        const data = await this.graphql(closingIssuesQuery(wanted), {owner: parts[1], name: parts[2]});
        return data ? toClosingIssues(data, repo, wanted) : null;
    }

    // ── The project page (#167): the queries and their mapping are in `gh-overview.ts` ──

    public async issuesIn(repo: string, options: {closed: boolean}): Promise<RepositoryIssue[] | null> {
        const parts = REPO.exec(repo);
        if (!parts) return null;
        const data = await this.graphql(issuesQuery(options.closed === true), {owner: parts[1], name: parts[2]});
        return data ? toRepositoryIssues(data, repo) : null;
    }

    public async latestTag(repo: string): Promise<{at: string | null} | null> {
        const parts = REPO.exec(repo);
        if (!parts) return null;
        const data = await this.graphql(LATEST_TAG_QUERY, {owner: parts[1], name: parts[2]});
        return data ? toLatestTag(data) : null;
    }

    public async pullRequestForBranch(repo: string, branch: string): Promise<{pr: BranchPullRequest | null} | null> {
        const parts = REPO.exec(repo);
        if (!parts || !branch) return null;
        const data = await this.graphql(BRANCH_PULL_REQUEST_QUERY, {owner: parts[1], name: parts[2], branch});
        return data ? toBranchPullRequest(data) : null;
    }

    public async recentTags(repo: string): Promise<{name: string; at: string}[] | null> {
        const parts = REPO.exec(repo);
        if (!parts) return null;
        const data = await this.graphql(RECENT_TAGS_QUERY, {owner: parts[1], name: parts[2]});
        return data ? toTags(data) : null;
    }

    public async refContains(repo: string, ref: string, sha: string): Promise<boolean | null> {
        if (!REPO.test(repo) || !/^[0-9a-f]{7,40}$/i.test(sha) || !ref) return null;
        const body = await this.getJson(`repos/${repo}/compare/${sha}...${encodeURIComponent(ref)}`);
        const status = body?.status;
        if (typeof status !== 'string') return null;
        // The tag is ahead of the commit, or is it: the commit is in the tag.
        return status === 'ahead' || status === 'identical';
    }

    public async inboxIssuesIn(repo: string): Promise<InboxIssuesAnswer | null> {
        const parts = REPO.exec(repo);
        if (!parts) return null;
        const data = await this.graphql(INBOX_ISSUES_QUERY, {owner: parts[1], name: parts[2]});
        return data ? toInboxIssues(data, repo) : null;
    }

    public async issueThread(repo: string, number: number): Promise<IssueThread | null> {
        const parts = REPO.exec(repo);
        if (!parts || !Number.isSafeInteger(number) || number < 1) return null;
        const data = await this.graphqlWith(ISSUE_THREAD_QUERY, [
            ['-f', 'owner', parts[1]],
            ['-f', 'name', parts[2]],
            ['-F', 'number', String(number)],
        ]);
        return data ? toIssueThread(data) : null;
    }

    // ── The Issue manager's writes (#415) ──

    public async assignSelf(repo: string, number: number): Promise<GitHubWrite> {
        if (!issueRef(repo, number)) return {ok: false, reason: 'That issue cannot be assigned'};
        return this.rest(['issue', 'edit', String(number), '--repo', repo, '--add-assignee', '@me']);
    }

    public async unassignSelf(repo: string, number: number): Promise<GitHubWrite> {
        if (!issueRef(repo, number)) return {ok: false, reason: 'That issue cannot be unassigned'};
        return this.rest(['issue', 'edit', String(number), '--repo', repo, '--remove-assignee', '@me']);
    }

    public async commentOnIssue(repo: string, number: number, body: string): Promise<GitHubWrite> {
        if (!issueRef(repo, number) || !body.trim()) return {ok: false, reason: 'That comment cannot be posted'};
        // `--body=` keeps a body that starts with a dash from being read as a flag.
        return this.rest(['issue', 'comment', String(number), '--repo', repo, '--body=' + body]);
    }

    public async pullRequestsIn(repo: string, options: {merged: boolean}): Promise<RepositoryPullRequest[] | null> {
        const parts = REPO.exec(repo);
        if (!parts) return null;
        const data = await this.graphql(pullRequestsInQuery(options.merged === true), {
            owner: parts[1],
            name: parts[2],
        });
        return data ? toRepositoryPullRequests(data, repo) : null;
    }

    public async ciRunDurations(repo: string): Promise<number[] | null> {
        if (!REPO.test(repo)) return null;
        const result = await this.run(ciRunsArgs(repo));
        if (result.missing || result.code !== 0) return null;
        try {
            return toCiRunDurations(JSON.parse(result.stdout));
        } catch {
            return null;
        }
    }

    // ── The Merge manager (#434): the queries and their mapping are in `gh-lanes.ts` ──

    public async queuedPullRequests(): Promise<{repository: string; number: number}[] | null> {
        const data = await this.graphql(QUEUED_PULL_REQUESTS_QUERY, {search: QUEUED_SEARCH});
        return data ? toQueuedPullRequests(data) : null;
    }

    public async laneRead(repo: string, numbers: readonly number[]): Promise<LaneRead | null> {
        const parts = REPO.exec(repo);
        if (!parts) return null;
        const wanted = validNumbers(numbers);
        const data = await this.graphql(laneQuery(wanted), {owner: parts[1], name: parts[2]});
        return data ? toLaneRead(data, repo, wanted) : null;
    }

    public async workflowFiles(repo: string): Promise<WorkflowFile[] | null> {
        const parts = REPO.exec(repo);
        if (!parts) return null;
        const data = await this.graphql(WORKFLOWS_QUERY, {owner: parts[1], name: parts[2]});
        return data ? toWorkflowFiles(data) : null;
    }

    // ── The Switchboard lane runner's writes (#435) ──

    public async updateBranch(pullRequestId: string, expectedHeadOid: string): Promise<BranchUpdate> {
        if (!pullRequestId || !/^[0-9a-f]{7,64}$/i.test(expectedHeadOid)) {
            return {ok: false, why: 'refused', reason: 'That pull request cannot be updated'};
        }
        const answer = await this.mutate(UPDATE_BRANCH_MUTATION, [
            ['-f', 'pullRequestId', pullRequestId],
            ['-f', 'expectedHeadOid', expectedHeadOid],
        ]);
        return answer.ok ? {ok: true} : {ok: false, why: toBranchUpdateFailure(answer.reason), reason: answer.reason};
    }

    public async mergePullRequest(
        repo: string,
        number: number,
        sha: string,
        method: MergeMethod,
    ): Promise<MergeAnswer> {
        if (
            !issueRef(repo, number) ||
            !/^[0-9a-f]{7,64}$/i.test(sha) ||
            !['squash', 'merge', 'rebase'].includes(method)
        ) {
            return {ok: false, status: null, reason: 'That pull request cannot be merged'};
        }
        const result = await this.run([
            'api',
            '--method',
            'PUT',
            lanePaths.merge(repo, number),
            '-f',
            `sha=${sha}`,
            '-f',
            `merge_method=${method}`,
        ]);
        if (result.missing) return {ok: false, status: null, reason: 'gh is not installed'};
        if (isAuthFailure(result)) return {ok: false, status: null, reason: 'gh is not signed in to github.com'};
        if (result.code === 0) return {ok: true};
        return {ok: false, status: httpStatus(result.stderr), reason: failureReason(result)};
    }

    public async forceCancelRun(repo: string, runId: number): Promise<GitHubWrite> {
        if (!REPO.test(repo) || !isId(runId)) return {ok: false, reason: 'That run cannot be cancelled'};
        return this.rest(['api', '--method', 'POST', lanePaths.forceCancel(repo, runId)]);
    }

    // ── The merge queue's labels (#315) ──

    public async addLabel(repo: string, number: number, label: string): Promise<GitHubWrite> {
        const path = labelsPath(repo, number);
        if (!path || !label) return {ok: false, reason: 'That label cannot be added'};
        return this.rest(['api', '--method', 'POST', path, '-f', `labels[]=${label}`]);
    }

    public async removeLabel(repo: string, number: number, label: string): Promise<GitHubWrite> {
        const path = labelsPath(repo, number);
        if (!path || !label) return {ok: false, reason: 'That label cannot be removed'};
        return this.rest(['api', '--method', 'DELETE', `${path}/${encodeURIComponent(label)}`]);
    }

    // ── The CI job queue: the paths and their mapping are in `gh-ci-jobs.ts` ──

    public async selfHostedRunners(repo: string): Promise<Runner[] | null> {
        const parts = REPO.exec(repo);
        if (!parts) return null;
        const [own, org] = await Promise.all([
            this.getJson(ciJobPaths.repoRunners(repo)),
            this.getJson(ciJobPaths.orgRunners(parts[1])),
        ]);
        const read = [toRunners(own), toRunners(org)].filter((runners): runners is Runner[] => runners !== null);
        if (read.length === 0) return null;
        const byName = new Map<string, Runner>();
        for (const runner of read.flat()) if (!byName.has(runner.name)) byName.set(runner.name, runner);
        return [...byName.values()];
    }

    public async ciJobs(repo: string): Promise<CiJob[] | null> {
        if (!REPO.test(repo)) return null;
        const [runs, pulls] = await Promise.all([
            this.getJson(ciJobPaths.runs(repo)),
            this.getJson(ciJobPaths.pulls(repo)),
        ]);
        const active = toActiveRuns(runs, pulls);
        if (!active) return null;
        const jobs = await Promise.all(
            active.map(async (run) => toCiJobs(run, await this.getJson(ciJobPaths.jobs(repo, run.id)))),
        );
        return jobs.flat();
    }

    public async successfulRuns(repo: string, workflowId: number, count: number): Promise<number[] | null> {
        if (!REPO.test(repo) || !isId(workflowId) || !isId(count)) return null;
        return toRunIds(await this.getJson(ciJobPaths.successfulRuns(repo, workflowId, count)));
    }

    public async runJobTimes(repo: string, runId: number, workflowId: number): Promise<TimedRun | null> {
        if (!REPO.test(repo) || !isId(runId)) return null;
        return toTimedRun(runId, workflowId, await this.getJson(ciJobPaths.jobs(repo, runId)));
    }

    public async runCompleted(repo: string, runId: number): Promise<boolean | null> {
        if (!REPO.test(repo) || !isId(runId)) return null;
        return toRunCompleted(await this.getJson(ciJobPaths.run(repo, runId)));
    }

    public async cancelRun(repo: string, runId: number): Promise<GitHubWrite> {
        if (!REPO.test(repo) || !isId(runId)) return {ok: false, reason: 'That run cannot be cancelled'};
        return this.rest(['api', '--method', 'POST', ciJobPaths.cancel(repo, runId)]);
    }

    public async rerunFailedJobs(repo: string, runId: number): Promise<GitHubWrite> {
        if (!REPO.test(repo) || !isId(runId)) return {ok: false, reason: 'That run cannot be run again'};
        return this.rest(['api', '--method', 'POST', ciJobPaths.rerunFailed(repo, runId)]);
    }

    /** A REST read's JSON; null when `gh` could not ask or GitHub refused. */
    private async getJson(path: string): Promise<any | null> {
        const result = await this.run(['api', path]);
        if (result.missing || result.code !== 0) return null;
        try {
            return JSON.parse(result.stdout);
        } catch {
            return null;
        }
    }

    /** Run a REST write; whether it went through, or GitHub's reason it did not. */
    private async rest(args: string[]): Promise<GitHubWrite> {
        const result = await this.run(args);
        if (result.missing) return {ok: false, reason: 'gh is not installed'};
        if (isAuthFailure(result)) return {ok: false, reason: 'gh is not signed in to github.com'};
        if (result.code === 0) return {ok: true};
        return {ok: false, reason: failureReason(result)};
    }

    // ── Your review (C3) ──
    //
    // Every value goes in as a GraphQL variable, never into the query text: a
    // comment's body is whatever you typed. Strings go with `-f`, which `gh`
    // passes verbatim (`-F` would read a body starting with `@` as a file); only
    // the line number goes with `-F`, which makes it an Int.

    public async startPendingReview(pullRequestId: string): Promise<GitHubWrite<{reviewId: string}>> {
        const answer = await this.mutate(START_REVIEW, [['-f', 'pullRequestId', pullRequestId]]);
        if (!answer.ok) return answer;
        const reviewId = answer.data.addPullRequestReview?.pullRequestReview?.id;
        return typeof reviewId === 'string' && reviewId
            ? {ok: true, reviewId}
            : {ok: false, reason: 'GitHub did not start the review'};
    }

    public async addPendingComment(
        reviewId: string,
        comment: NewLineComment,
    ): Promise<GitHubWrite<{threadId: string}>> {
        if (!Number.isSafeInteger(comment.line) || comment.line < 1)
            return {ok: false, reason: 'That line cannot take a comment'};
        const answer = await this.mutate(ADD_COMMENT, [
            ['-f', 'reviewId', reviewId],
            ['-f', 'path', comment.path],
            ['-F', 'line', String(comment.line)],
            ['-f', 'side', comment.side === 'LEFT' ? 'LEFT' : 'RIGHT'],
            ['-f', 'body', comment.body],
        ]);
        if (!answer.ok) return answer;
        const threadId = answer.data.addPullRequestReviewThread?.thread?.id;
        return typeof threadId === 'string' && threadId
            ? {ok: true, threadId}
            : {ok: false, reason: 'GitHub did not add the comment'};
    }

    public async deletePendingReview(reviewId: string): Promise<GitHubWrite> {
        const answer = await this.mutate(DELETE_REVIEW, [['-f', 'reviewId', reviewId]]);
        return answer.ok ? {ok: true} : answer;
    }

    public async submitPendingReview(reviewId: string, event: ReviewEvent): Promise<GitHubWrite> {
        const answer = await this.mutate(SUBMIT_REVIEW, [
            ['-f', 'reviewId', reviewId],
            ['-f', 'event', event === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT'],
        ]);
        return answer.ok ? {ok: true} : answer;
    }

    /** Run a mutation; answer its `data`, or why it did not go through. */
    private async mutate(
        mutation: string,
        variables: ReadonlyArray<readonly ['-f' | '-F', string, string]>,
    ): Promise<{ok: true; data: any} | {ok: false; reason: string}> {
        const args = ['api', 'graphql', '-f', 'query=' + mutation];
        for (const [flag, key, value] of variables) args.push(flag, `${key}=${value}`);
        const result = await this.run(args);
        if (result.missing) return {ok: false, reason: 'gh is not installed'};
        if (isAuthFailure(result)) return {ok: false, reason: 'gh is not signed in to github.com'};
        let body: {data?: any; errors?: Array<{message?: unknown}>} | null = null;
        try {
            body = JSON.parse(result.stdout);
        } catch {
            body = null;
        }
        const error = body?.errors?.find((e) => typeof e?.message === 'string')?.message as string | undefined;
        if (error) return {ok: false, reason: error};
        if (result.code === 0 && body?.data && typeof body.data === 'object') return {ok: true, data: body.data};
        const stderr = result.stderr.trim().split('\n').pop()?.replace(/^gh: /, '');
        return {ok: false, reason: stderr || 'GitHub did not answer'};
    }

    /**
     * Run a GraphQL query and answer its `data`, or null.
     *
     * GraphQL answers what it could and lists errors for the rest — a PR number
     * that does not exist is a NOT_FOUND error next to everyone else's data —
     * and `gh` exits 1 for that, so a failed exit with `data` in it is still an
     * answer.
     */
    private async graphql(query: string, variables: Record<string, string>): Promise<any | null> {
        return this.graphqlWith(
            query,
            Object.entries(variables).map(([key, value]) => ['-f', key, value] as const),
        );
    }

    /** `graphql` with typed variables: `-F` makes a number an Int. */
    private async graphqlWith(
        query: string,
        variables: ReadonlyArray<readonly ['-f' | '-F', string, string]>,
    ): Promise<any | null> {
        const args = ['api', 'graphql', '-f', 'query=' + query];
        for (const [flag, key, value] of variables) args.push(flag, `${key}=${value}`);
        const result = await this.run(args);
        if (result.missing || isAuthFailure(result)) return null;
        try {
            const body = JSON.parse(result.stdout) as {data?: unknown};
            return body.data && typeof body.data === 'object' ? body.data : null;
        } catch {
            return null;
        }
    }
}

/**
 * The review mutations. A pending review is one started without an `event`;
 * a thread added to it stays pending, visible only to you, until the review
 * is submitted.
 */
export const START_REVIEW = `mutation($pullRequestId: ID!) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId }) { pullRequestReview { id } }
}`;

export const ADD_COMMENT = `mutation($reviewId: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $reviewId, path: $path, line: $line, side: $side, body: $body
  }) { thread { id } }
}`;

export const DELETE_REVIEW = `mutation($reviewId: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) { pullRequestReview { id } }
}`;

export const SUBMIT_REVIEW = `mutation($reviewId: ID!, $event: PullRequestReviewEvent!) {
  submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event }) { pullRequestReview { id state } }
}`;

/** GitHub's reason a REST write failed: the body's `message`, else `gh`'s last line. */
function failureReason(result: GhResult): string {
    let message: unknown = null;
    try {
        message = (JSON.parse(result.stdout) as {message?: unknown})?.message;
    } catch {
        message = null;
    }
    if (typeof message === 'string' && message) return message;
    const stderr = result.stderr.trim().split('\n').pop()?.replace(/^gh: /, '');
    return stderr || 'GitHub did not answer';
}

/** The REST path of an issue's or PR's labels; null for a repository or number that is not one. */
function issueRef(repo: string, number: number): boolean {
    return REPO.test(repo) && Number.isSafeInteger(number) && number >= 1;
}

function labelsPath(repo: string, number: number): string | null {
    if (!REPO.test(repo) || !Number.isSafeInteger(number) || number < 1) return null;
    return `repos/${repo}/issues/${number}/labels`;
}

/** A positive integer, as written into a REST path. */
function isId(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

/** Positive integers only, once each: they are written into the query text. */
function validNumbers(numbers: readonly number[]): number[] {
    return [...new Set(numbers.filter((n) => Number.isSafeInteger(n) && n > 0))];
}

const PULL_REQUEST_FIELDS = `
  id
  number url title state isDraft isCrossRepository mergeable additions deletions viewerDidAuthor
  autoMergeRequest { enabledAt }
  headRefName headRefOid baseRefName
  repository {
    defaultBranchRef { name }
  }
  headRef { compare(headRef: "HEAD") { aheadBy } }
  statusCheckRollup {
    contexts(first: 100) {
      nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      }
    }
  }
  closingIssuesReferences(first: 20) { nodes { number repository { nameWithOwner } } }
  reviewThreads(first: 100) {
    nodes {
      id path line originalLine diffSide isResolved resolvedBy { login }
      comments(first: 50) { nodes { id state body createdAt author { __typename login } } }
    }
  }
  reviews(states: PENDING, first: 1) {
    nodes { id comments(first: 100) { nodes { id path line originalLine body } } }
  }`;

/** One request for every PR: one aliased field each, `pr<number>`. */
export function pullRequestsQuery(numbers: readonly number[]): string {
    const fields = numbers.map((number) => `pr${number}: pullRequest(number: ${number}) { ...pr }`);
    return `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) { ${fields.join(' ')} }
}
fragment pr on PullRequest {${PULL_REQUEST_FIELDS}
}`;
}

// The response is read field by field with a fallback for each, so it is
// typed `any` rather than modelled: GraphQL's shape is the query above.

function toPullRequest(node: any, repo: string, viewer: string): PullRequestStatus {
    const pr: PullRequestStatus = {
        number: node.number,
        url: node.url,
        repository: repo,
        title: node.title,
        state: prState(node),
        checks: (node.statusCheckRollup?.contexts?.nodes ?? []).filter(Boolean).map(toCheck),
        mergeable:
            node.mergeable === 'MERGEABLE' ? 'mergeable' : node.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
        closes: (node.closingIssuesReferences?.nodes ?? []).filter(Boolean).map((issue: any): IssueRef => ({
            repository: issue.repository?.nameWithOwner ?? repo,
            number: issue.number,
        })),
        headRef: node.headRefName,
        headSha: node.headRefOid,
        baseRef: node.baseRefName,
    };
    if (typeof node.additions === 'number') pr.additions = node.additions;
    if (typeof node.deletions === 'number') pr.deletions = node.deletions;
    if (node.autoMergeRequest) pr.autoMerge = true;
    if (typeof node.viewerDidAuthor === 'boolean') pr.mine = node.viewerDidAuthor;

    const behindBy = behindBase(node);
    if (behindBy !== undefined) pr.behindBy = behindBy;

    const {threads, pending} = reviewThreads(node, viewer);
    pr.threads = threads;
    pr.pendingReview = pending;
    if (typeof node.id === 'string' && node.id) pr.nodeId = node.id;
    const pendingReviewId = node.reviews?.nodes?.[0]?.id;
    if (typeof pendingReviewId === 'string' && pendingReviewId) pr.pendingReviewId = pendingReviewId;
    return pr;
}

function prState(node: any): PullRequestStatus['state'] {
    if (node.state === 'MERGED') return 'merged';
    if (node.state === 'CLOSED') return 'closed';
    return node.isDraft ? 'draft' : 'open';
}

/**
 * How many commits the base branch has that the head does not.
 *
 * GraphQL cannot compare a PR's head with its base in one request, because
 * `compare` takes the other ref's name as an argument and the base's name is
 * part of the answer. It can compare the head with the default branch
 * (`HEAD`), which is the base of nearly every PR a session opens (A3 offers
 * "Rebase on origin/main"). For a PR on another base, a fork's PR, or one
 * whose branch is gone, the answer is left unknown.
 */
function behindBase(node: any): number | undefined {
    if (node.isCrossRepository) return undefined;
    const defaultBranch = node.repository?.defaultBranchRef?.name;
    if (!defaultBranch || node.baseRefName !== defaultBranch) return undefined;
    const aheadBy = node.headRef?.compare?.aheadBy;
    return typeof aheadBy === 'number' ? aheadBy : undefined;
}

/** A bot is a `Bot` actor, or an app account whose login says so. */
function isBot(author: any): boolean {
    return author?.__typename === 'Bot' || (typeof author?.login === 'string' && author.login.endsWith('[bot]'));
}

/**
 * The PR's submitted review threads, and your pending review's comments.
 *
 * A pending comment also shows up as a thread, visible only to you, made only
 * of pending comments; it is not a thread anyone can answer yet, so it is
 * kept out of the threads and its side is taken from it for the pending
 * comment, which does not carry one itself.
 */
function reviewThreads(node: any, viewer: string): {threads: ReviewThread[]; pending: PendingComment[]} {
    const threads: ReviewThread[] = [];
    const sideOfComment = new Map<string, DiffSide>();
    const threadOfComment = new Map<string, string>();

    for (const thread of node.reviewThreads?.nodes ?? []) {
        if (!thread) continue;
        const side: DiffSide = thread.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT';
        const all = (thread.comments?.nodes ?? []).filter(Boolean);
        for (const comment of all) {
            if (!comment.id) continue;
            sideOfComment.set(comment.id, side);
            if (typeof thread.id === 'string') threadOfComment.set(comment.id, thread.id);
        }

        const posted = all.filter((comment: any) => comment.state !== 'PENDING');
        if (posted.length === 0) continue;

        const comments: ThreadComment[] = posted.map((comment: any) => ({
            author: comment.author?.login ?? 'ghost',
            isBot: isBot(comment.author),
            body: comment.body ?? '',
            createdAt: comment.createdAt ?? '',
        }));
        const resolved = thread.isResolved === true;
        const last = comments[comments.length - 1];
        threads.push({
            id: thread.id,
            path: thread.path ?? '',
            line: typeof thread.line === 'number' ? thread.line : null,
            side,
            resolved,
            // Claude posts as you, so its reply on an open thread is your login
            // having the last word: it answered and wants your call (C5).
            needsYou: !resolved && viewer !== '' && last.author === viewer,
            comments,
            ...(resolved && typeof thread.resolvedBy?.login === 'string' ? {resolvedBy: thread.resolvedBy.login} : {}),
        });
    }

    const pending: PendingComment[] = [];
    for (const comment of node.reviews?.nodes?.[0]?.comments?.nodes ?? []) {
        if (!comment) continue;
        const line = typeof comment.line === 'number' ? comment.line : comment.originalLine;
        if (typeof line !== 'number') continue;
        const threadId = threadOfComment.get(comment.id);
        pending.push({
            path: comment.path ?? '',
            line,
            side: sideOfComment.get(comment.id) ?? 'RIGHT',
            body: comment.body ?? '',
            ...(threadId ? {threadId} : {}),
        });
    }
    return {threads, pending};
}

/**
 * `gh run view --log` prefixes each line with the job, the step and a
 * timestamp, tab-separated. The prompt only needs what the step printed.
 */
function stripLogPrefix(line: string): string {
    const fields = line.split('\t');
    const text = fields.length >= 3 ? fields.slice(2).join('\t') : line;
    return text.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, '');
}

function tail(lines: string[], count: number): string {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(Math.max(0, lines.length - Math.max(0, count))).join('\n');
}
