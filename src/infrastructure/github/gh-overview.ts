/**
 * The project page's GraphQL (#167): the queries `GhCli` sends for a
 * repository's issues and pull requests, and how each answer maps onto the
 * overview domain.
 *
 * Kept apart from `gh-cli.ts`, like `gh-plans.ts`, so the mapping can be
 * tested from recorded responses on its own. The repository travels as
 * variables; the states written into a query's text are fixed. Responses are
 * read field by field with a fallback for each, so they are typed `any`.
 *
 * The merge queue (#315) rides on the same pull request read: each PR's base,
 * labels, the queue's `automerge` status, its reviewers and the check runs on
 * its head commit come in that one request, so the queue costs no `gh` call
 * per PR. Only the durations of the repository's green CI runs are one more
 * read (`ciRunsArgs`, `toCiRunDurations`).
 */
import type {IssueKey} from '../../domain/plan/model';
import {
    AUTOMERGE_CONTEXT,
    MIN_RUNS_FOR_ESTIMATE,
    type AutomergeStatus,
    type QueueCheckRun,
} from '../../domain/project/merge-queue';
import type {
    CheckRollup,
    IssueLabel,
    PullRequestQueueReads,
    RepositoryIssue,
    RepositoryPullRequest,
    ReviewDecision,
} from '../../domain/project/overview';

/**
 * Issues per repository: the 100 most recently updated, unpaged. One page is
 * the most GitHub hands out per connection, and a project page that lists more
 * than that would not be read anyway.
 */
export const ISSUES_PER_REPOSITORY = 100;

/** Pull requests per repository: the 50 most recently updated, unpaged. */
export const PULL_REQUESTS_PER_REPOSITORY = 50;

const ORDER = '{ field: UPDATED_AT, direction: DESC }';

/** A repository's issues, open ones only unless closed ones are wanted. */
export function issuesQuery(closed: boolean): string {
    return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: ${closed ? '[OPEN, CLOSED]' : '[OPEN]'}, first: ${ISSUES_PER_REPOSITORY}, orderBy: ${ORDER}) {
      nodes {
        number title state updatedAt
        repository { nameWithOwner }
        labels(first: 20) { nodes { name color } }
        parent { number repository { nameWithOwner } }
        subIssuesSummary { total }
      }
    }
  }
}`;
}

/** The issues in `issuesQuery`'s data, newest first; null when it holds no repository. */
export function toRepositoryIssues(data: any, repo: string): RepositoryIssue[] | null {
    const nodes = data?.repository?.issues?.nodes;
    if (!Array.isArray(nodes)) return null;
    return nodes
        .filter((node: any) => node && typeof node.number === 'number')
        .map((node: any): RepositoryIssue => {
            const repository = nameOf(node, repo);
            const parent =
                node.parent && typeof node.parent.number === 'number'
                    ? {repository: nameOf(node.parent, repository), number: node.parent.number}
                    : null;
            const total = node.subIssuesSummary?.total;
            return {
                repository,
                number: node.number,
                title: node.title ?? '',
                state: node.state === 'OPEN' ? 'open' : 'closed',
                labels: (node.labels?.nodes ?? []).filter((label: any) => typeof label?.name === 'string').map(toLabel),
                updatedAt: node.updatedAt ?? '',
                parent,
                subIssues: typeof total === 'number' ? total : 0,
            };
        })
        .sort((a: RepositoryIssue, b: RepositoryIssue) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Check runs read per PR for the merge queue's head stage: the first 50 on its head commit. */
export const CHECK_RUNS_PER_PULL_REQUEST = 50;

/**
 * A repository's pull requests, open ones only unless merged ones are wanted.
 * Checks are counted by state for the page's one pill, and listed (check runs
 * only) for the merge queue. The queue's `automerge` status is asked for by
 * name, so it is found however many other statuses the commit has. Requested
 * reviewers are read as users only: a team would need `read:org`.
 */
export function pullRequestsInQuery(merged: boolean): string {
    return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: ${merged ? '[OPEN, MERGED]' : '[OPEN]'}, first: ${PULL_REQUESTS_PER_REPOSITORY}, orderBy: ${ORDER}) {
      nodes {
        number title state isDraft headRefName baseRefName url updatedAt reviewDecision
        repository { nameWithOwner }
        statusCheckRollup {
          state
          contexts(first: ${CHECK_RUNS_PER_PULL_REQUEST}) {
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
            nodes { ... on CheckRun { name status conclusion startedAt } }
          }
        }
        closingIssuesReferences(first: 20) { nodes { number repository { nameWithOwner } } }
        labels(first: 20) { nodes { name } }
        commits(last: 1) { nodes { commit { status { context(name: "${AUTOMERGE_CONTEXT}") { state description } } } } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        latestReviews(first: 20) { nodes { state author { login } } }
      }
    }
  }
}`;
}

/** The PRs in `pullRequestsInQuery`'s data, newest first; null when it holds no repository. */
export function toRepositoryPullRequests(data: any, repo: string): RepositoryPullRequest[] | null {
    const nodes = data?.repository?.pullRequests?.nodes;
    if (!Array.isArray(nodes)) return null;
    return nodes
        .filter((node: any) => node && typeof node.number === 'number')
        .map((node: any): RepositoryPullRequest => {
            const repository = nameOf(node, repo);
            return {
                repository,
                number: node.number,
                title: node.title ?? '',
                state: node.state === 'MERGED' ? 'merged' : 'open',
                draft: node.isDraft === true,
                headRef: node.headRefName ?? '',
                updatedAt: node.updatedAt ?? '',
                checks: toCheckRollup(node.statusCheckRollup),
                review: toReviewDecision(node.reviewDecision),
                closes: (node.closingIssuesReferences?.nodes ?? [])
                    .filter((issue: any) => issue && typeof issue.number === 'number')
                    .map((issue: any): IssueKey => ({repository: nameOf(issue, repository), number: issue.number})),
                queue: toQueueReads(node, repository),
            };
        })
        .sort((a: RepositoryPullRequest, b: RepositoryPullRequest) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * What the merge queue reads of a PR node. A field GitHub left out reads as
 * nothing: no labels, no `automerge` status, no reviewers, no check runs.
 */
export function toQueueReads(node: any, repository: string): PullRequestQueueReads {
    const url =
        typeof node?.url === 'string' && node.url ? node.url : `https://github.com/${repository}/pull/${node?.number}`;
    return {
        url,
        baseRef: typeof node?.baseRefName === 'string' ? node.baseRefName : '',
        labels: namesOf(node?.labels?.nodes, (label) => label?.name),
        automerge: toAutomergeStatus(node?.commits?.nodes?.[0]?.commit?.status?.context),
        requestedReviewers: namesOf(node?.reviewRequests?.nodes, (request) => request?.requestedReviewer?.login),
        approvedBy: namesOf(
            (Array.isArray(node?.latestReviews?.nodes) ? node.latestReviews.nodes : []).filter(
                (review: any) => review?.state === 'APPROVED',
            ),
            (review) => review?.author?.login,
        ),
        checks: (Array.isArray(node?.statusCheckRollup?.contexts?.nodes) ? node.statusCheckRollup.contexts.nodes : [])
            .filter((check: any) => typeof check?.name === 'string' && check.name)
            .map(toQueueCheckRun),
    };
}

/** The queue's `automerge` status context; null when the commit has none. */
function toAutomergeStatus(context: any): AutomergeStatus | null {
    if (!context || typeof context.state !== 'string') return null;
    const state: AutomergeStatus['state'] =
        context.state === 'SUCCESS'
            ? 'success'
            : context.state === 'FAILURE'
              ? 'failure'
              : context.state === 'ERROR'
                ? 'error'
                : 'pending';
    return {state, description: typeof context.description === 'string' ? context.description : ''};
}

/** Check run conclusions that count as a failure, as `FAILING_CHECK_RUNS` counts them (bar a cancel). */
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

/**
 * A check run as the queue reads it. Unfinished, it is `running` once in
 * progress and `queued` before that (with no start time, as the queue
 * expects); finished, its conclusion decides, a neutral one passing.
 */
export function toQueueCheckRun(check: any): QueueCheckRun {
    const started = typeof check.startedAt === 'string' ? Date.parse(check.startedAt) : NaN;
    const startedAt = Number.isFinite(started) ? started : null;
    if (check.status !== 'COMPLETED') {
        return check.status === 'IN_PROGRESS'
            ? {name: check.name, state: 'running', startedAt}
            : {name: check.name, state: 'queued', startedAt: null};
    }
    const conclusion = check.conclusion;
    const state: QueueCheckRun['state'] =
        conclusion === 'SUCCESS' || conclusion === 'NEUTRAL'
            ? 'passed'
            : conclusion === 'SKIPPED'
              ? 'skipped'
              : conclusion === 'CANCELLED'
                ? 'cancelled'
                : FAILED_CONCLUSIONS.has(conclusion)
                  ? 'failed'
                  : 'passed';
    return {name: check.name, state, startedAt};
}

function namesOf(nodes: any, name: (node: any) => unknown): string[] {
    if (!Array.isArray(nodes)) return [];
    const names = nodes.map(name).filter((value): value is string => typeof value === 'string' && value !== '');
    return [...new Set(names)];
}

// ── CI run durations, for the merge queue's estimates ──

/** How many green runs one CI workflow's median is taken over. */
export const CI_RUNS_PER_ESTIMATE = 20;

/**
 * How many green runs are listed to find them: across every workflow, so the
 * CI workflow still has its 20 among the others' runs.
 */
export const CI_RUNS_LISTED = 100;

/** The `gh run list` that `toCiRunDurations` reads: the repository's latest green runs, newest first. */
export function ciRunsArgs(repo: string): string[] {
    return [
        'run',
        'list',
        '--repo',
        repo,
        '--status',
        'success',
        '--limit',
        String(CI_RUNS_LISTED),
        '--json',
        'workflowName,event,createdAt,startedAt,updatedAt',
    ];
}

/**
 * How long the repository's CI workflow's last 20 green runs took, ms, from
 * `gh run list`'s JSON (`ciRunsArgs`); null when that is not a list of runs.
 *
 * Which workflow is "the CI" is not written anywhere `gh` can read cheaply,
 * so it is chosen from the runs themselves: of the workflows run for pull
 * requests (every workflow when none was), the slowest by its median green
 * run. The queue's head waits for all of its required checks, so the slowest
 * workflow sets its pace; a workflow with fewer runs than an estimate needs is
 * only chosen when none has that many. A run lasts from its start (or, when
 * `gh` does not say, its creation) to its last update, which for a finished
 * run is when it finished.
 */
export function toCiRunDurations(runs: unknown): number[] | null {
    if (!Array.isArray(runs)) return null;
    const timed = runs
        .map((run: any) => {
            const end = Date.parse(run?.updatedAt);
            const start = Date.parse(run?.startedAt || run?.createdAt);
            return {
                workflow: typeof run?.workflowName === 'string' ? run.workflowName : '',
                pullRequest: run?.event === 'pull_request' || run?.event === 'pull_request_target',
                ms: end - start,
            };
        })
        .filter((run) => run.workflow !== '' && Number.isFinite(run.ms) && run.ms > 0);
    const forPullRequests = timed.filter((run) => run.pullRequest);
    const candidates = forPullRequests.length > 0 ? forPullRequests : timed;

    const byWorkflow = new Map<string, number[]>();
    for (const run of candidates) {
        const durations = byWorkflow.get(run.workflow) ?? [];
        if (durations.length < CI_RUNS_PER_ESTIMATE) durations.push(run.ms);
        byWorkflow.set(run.workflow, durations);
    }
    const workflows = [...byWorkflow.values()];
    const enough = workflows.filter((durations) => durations.length >= MIN_RUNS_FOR_ESTIMATE);
    const pool = enough.length > 0 ? enough : workflows;
    let slowest: number[] = [];
    for (const durations of pool) {
        if (slowest.length === 0 || median(durations) > median(slowest)) slowest = durations;
    }
    return slowest;
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// ── Fields ──

/**
 * The check run and status states that someone has to act on, as `gh-cli.ts`
 * reads a single check: a failure, an error, and a run that was cancelled,
 * timed out, went stale or needs an action.
 */
const FAILING_CHECK_RUNS = new Set([
    'FAILURE',
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE',
]);
const FAILING_STATUSES = new Set(['FAILURE', 'ERROR']);

/**
 * The rollup a PR's checks add up to. One failed check makes it `failing`,
 * even while others still run; otherwise GitHub's own rollup state decides.
 */
function toCheckRollup(rollup: any): CheckRollup {
    if (!rollup) return {state: 'none', failing: 0};
    const failing =
        countOf(rollup.contexts?.checkRunCountsByState, FAILING_CHECK_RUNS) +
        countOf(rollup.contexts?.statusContextCountsByState, FAILING_STATUSES);
    if (failing > 0 || rollup.state === 'FAILURE' || rollup.state === 'ERROR') return {state: 'failing', failing};
    if (rollup.state === 'SUCCESS') return {state: 'passing', failing: 0};
    return {state: 'running', failing: 0};
}

function countOf(counts: any, states: ReadonlySet<string>): number {
    if (!Array.isArray(counts)) return 0;
    return counts.reduce(
        (sum: number, entry: any) =>
            sum + (states.has(entry?.state) && typeof entry.count === 'number' ? entry.count : 0),
        0,
    );
}

function toReviewDecision(decision: unknown): ReviewDecision {
    if (decision === 'APPROVED') return 'approved';
    if (decision === 'CHANGES_REQUESTED') return 'changes_requested';
    if (decision === 'REVIEW_REQUIRED') return 'review_required';
    return null;
}

function toLabel(label: any): IssueLabel {
    return {name: label.name, color: typeof label.color === 'string' ? label.color : ''};
}

function nameOf(node: any, fallback: string): string {
    const name = node?.repository?.nameWithOwner;
    return typeof name === 'string' && name ? name : fallback;
}
