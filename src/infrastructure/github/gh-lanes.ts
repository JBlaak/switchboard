/**
 * The Merge manager's reads (#434): the GraphQL `GhCli` sends for them, and
 * how the answers map onto the lane's reads.
 *
 * - **Your queued PRs**: one search across GitHub for your open PRs carrying
 *   a queue label, wherever it was added. One request, whatever the number
 *   of repositories.
 * - **A lane**: the slim read the Merge manager polls every minute, landed
 *   PRs only, each an aliased `pullRequest(number:)`, with the trunk, its oid
 *   and its rules. About one point, against the project page's 67 (#421).
 *   With each PR its node id and the workflow runs on its head commit, and
 *   the merge methods the repository and its rules allow, for the lane
 *   runner (#435).
 * - **The workflows**: the files in `.github/workflows` on the default
 *   branch, for the lane kind; read rarely, so their text is no burden.
 *
 * Kept apart from `gh-cli.ts`, like `gh-overview.ts`, so the mapping can be
 * tested from recorded responses.
 */
import {AUTOMERGE_CONTEXT, QUEUE_LABELS} from '../../domain/project/merge-queue';
import {unresolvedThreadCount, type ReviewThreadFacts} from '../../domain/project/pull-request-wait';
import type {
    LaneCheck,
    LaneRun,
    MergeMethod,
    LanePullRequestRead,
    LaneRead,
    TrunkRules,
    WorkflowFile,
} from '../../domain/merge-manager/model';
import {toAutomergeStatus, toQueueCheckRun, toReviewDecision} from './gh-overview';

/** Your queued PRs read per search: one page. More than this many waiting in queues is not a real case. */
export const QUEUED_PULL_REQUESTS = 50;

const LABEL_FILTER = [QUEUE_LABELS.optIn, QUEUE_LABELS.next, QUEUE_LABELS.failed]
    .map((label) => `"${label}"`)
    .join(',');

/** The search for your queued PRs: open, yours, in a repository that is not archived, with any queue label. */
export const QUEUED_SEARCH = `is:pr is:open author:@me archived:false label:${LABEL_FILTER}`;

export const QUEUED_PULL_REQUESTS_QUERY = `query($search: String!) {
  search(type: ISSUE, query: $search, first: ${QUEUED_PULL_REQUESTS}) {
    nodes { ... on PullRequest { number repository { nameWithOwner } } }
  }
}`;

/** Checks read per PR, and review threads: enough for any real head commit. */
const CHECKS_PER_PULL_REQUEST = 50;
const THREADS_PER_PULL_REQUEST = 50;
/** Check suites read per head commit, for their workflow runs. */
const SUITES_PER_PULL_REQUEST = 20;

/** The lane read of these PRs in one repository. */
export function laneQuery(numbers: readonly number[]): string {
    const fields = numbers.map((number) => `pr${number}: pullRequest(number: ${number}) { ...laneFields }`);
    return `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    defaultBranchRef {
      name
      target { oid }
      rules(first: 50) {
        nodes {
          type
          parameters {
            ... on RequiredStatusChecksParameters { requiredStatusChecks { context } }
            ... on PullRequestParameters { dismissStaleReviewsOnPush requireLastPushApproval allowedMergeMethods }
          }
        }
      }
    }
    ${fields.join('\n    ')}
  }
}

${laneFragment()}`;
}

/** What the lane read asks of each PR. */
function laneFragment(): string {
    return `fragment laneFields on PullRequest {
  id number title url state isDraft mergedAt headRefName headRefOid baseRefName baseRefOid reviewDecision mergeStateStatus
  author { login }
  labels(first: 20) { nodes { name } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { combinedSlug } } } }
  latestReviews(first: 20) { nodes { state author { login } } }
  reviewThreads(first: ${THREADS_PER_PULL_REQUEST}) { nodes { isResolved comments(first: 1) { totalCount nodes { body } } } }
  commits(last: 1) {
    nodes {
      commit {
        status { context(name: "${AUTOMERGE_CONTEXT}") { state description } }
        checkSuites(first: ${SUITES_PER_PULL_REQUEST}) { nodes { status conclusion workflowRun { databaseId } } }
        statusCheckRollup {
          contexts(first: ${CHECKS_PER_PULL_REQUEST}) {
            nodes {
              ... on CheckRun { name status conclusion startedAt }
              ... on StatusContext { context state createdAt }
            }
          }
        }
      }
    }
  }
}`;
}

export const WORKFLOWS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: "HEAD:.github/workflows") {
      ... on Tree { entries { name object { ... on Blob { text } } } }
    }
  }
}`;

// ── The lane runner's writes (#435) ──

/** Rebase a PR's branch onto its base, only while its head is the expected one. */
export const UPDATE_BRANCH_MUTATION = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, updateMethod: REBASE }) {
    pullRequest { headRefOid }
  }
}`;

/** The REST paths of a PR's merge and a run's force-cancel. */
export const lanePaths = {
    merge: (repo: string, number: number) => `repos/${repo}/pulls/${number}/merge`,
    forceCancel: (repo: string, runId: number) => `repos/${repo}/actions/runs/${runId}/force-cancel`,
};

/** Why `gh` could not ask GitHub at all, as `GhCli`'s writes word it. */
const UNAVAILABLE = /^(gh is not installed|gh is not signed in to github\.com|GitHub did not answer)$/;

/** What a refused branch update means for the lane: a conflict, a head that moved, GitHub out of reach, or else. */
export function toBranchUpdateFailure(reason: string): 'conflict' | 'moved' | 'unavailable' | 'refused' {
    if (UNAVAILABLE.test(reason) || /timed? ?out|could not resolve host|connection/i.test(reason)) return 'unavailable';
    if (/conflict/i.test(reason)) return 'conflict';
    if (/expected.*(head|oid|sha)|head.*(does not|doesn't) match|head ref.*(changed|moved)|stale/i.test(reason)) {
        return 'moved';
    }
    return 'refused';
}

/** The HTTP status `gh api` printed for a failed request (`… (HTTP 405)`); null when it printed none. */
export function httpStatus(stderr: string): number | null {
    const match = /\(HTTP (\d{3})\)/.exec(stderr) ?? /HTTP (\d{3})/.exec(stderr);
    return match ? Number(match[1]) : null;
}

// ── Mapping ──

/** The `owner/repo#n` of each PR the search found; null when the answer holds no search. */
export function toQueuedPullRequests(data: any): {repository: string; number: number}[] | null {
    const nodes = data?.search?.nodes;
    if (!Array.isArray(nodes)) return null;
    return nodes
        .filter((node: any) => typeof node?.number === 'number' && typeof node?.repository?.nameWithOwner === 'string')
        .map((node: any) => ({repository: node.repository.nameWithOwner, number: node.number}));
}

/** The lane read in `laneQuery`'s data; null when it holds no repository or trunk. */
export function toLaneRead(data: any, repo: string, numbers: readonly number[]): LaneRead | null {
    const repository = data?.repository;
    const trunk = repository?.defaultBranchRef;
    if (!repository || typeof trunk?.name !== 'string') return null;
    const name = typeof repository.nameWithOwner === 'string' ? repository.nameWithOwner : repo;
    const pullRequests: LanePullRequestRead[] = [];
    for (const number of numbers) {
        const node = repository['pr' + number];
        if (node && typeof node.number === 'number') pullRequests.push(toLanePullRequest(node, name));
    }
    return {
        repository: name,
        viewer: typeof data?.viewer?.login === 'string' ? data.viewer.login : '',
        trunk: trunk.name,
        trunkOid: typeof trunk.target?.oid === 'string' ? trunk.target.oid : '',
        rules: toTrunkRules(trunk.rules?.nodes),
        mergeMethods: toRepositoryMergeMethods(repository),
        pullRequests,
    };
}

/** The rules of every active ruleset on the trunk, taken together. */
export function toTrunkRules(nodes: any): TrunkRules {
    const rules = Array.isArray(nodes) ? nodes : [];
    const required = new Set<string>();
    let approvalLostOnPush = false;
    let linearHistory = false;
    let mergeMethods: MergeMethod[] | null = null;
    for (const rule of rules) {
        const parameters = rule?.parameters;
        if (rule?.type === 'REQUIRED_STATUS_CHECKS') {
            for (const check of Array.isArray(parameters?.requiredStatusChecks)
                ? parameters.requiredStatusChecks
                : []) {
                if (typeof check?.context === 'string' && check.context) required.add(check.context);
            }
        } else if (rule?.type === 'PULL_REQUEST') {
            if (parameters?.dismissStaleReviewsOnPush === true || parameters?.requireLastPushApproval === true) {
                approvalLostOnPush = true;
            }
            // Every ruleset must allow a method: what they allow together.
            if (Array.isArray(parameters?.allowedMergeMethods)) {
                const allowed = toMergeMethods(parameters.allowedMergeMethods);
                mergeMethods = mergeMethods ? mergeMethods.filter((method) => allowed.includes(method)) : allowed;
            }
        } else if (rule?.type === 'REQUIRED_LINEAR_HISTORY') {
            linearHistory = true;
        }
    }
    return {requiredChecks: [...required], approvalLostOnPush, mergeMethods, linearHistory};
}

/** The merge methods the repository's settings allow, in GitHub's order. */
function toRepositoryMergeMethods(repository: any): MergeMethod[] {
    const methods: MergeMethod[] = [];
    if (repository?.squashMergeAllowed === true) methods.push('squash');
    if (repository?.mergeCommitAllowed === true) methods.push('merge');
    if (repository?.rebaseMergeAllowed === true) methods.push('rebase');
    return methods;
}

function toMergeMethods(values: readonly unknown[]): MergeMethod[] {
    const methods: MergeMethod[] = [];
    for (const value of values) {
        const method = typeof value === 'string' ? value.toLowerCase() : '';
        if ((method === 'squash' || method === 'merge' || method === 'rebase') && !methods.includes(method)) {
            methods.push(method);
        }
    }
    return methods;
}

/** The workflow runs on a head commit, from its check suites; suites without a run (other apps) are left out. */
function toLaneRuns(nodes: any): LaneRun[] {
    if (!Array.isArray(nodes)) return [];
    const runs: LaneRun[] = [];
    for (const suite of nodes) {
        const id = suite?.workflowRun?.databaseId;
        if (!Number.isSafeInteger(id) || id <= 0 || runs.some((run) => run.id === id)) continue;
        const state: LaneRun['state'] =
            suite.status !== 'COMPLETED' ? 'unfinished' : suite.conclusion === 'CANCELLED' ? 'cancelled' : 'finished';
        runs.push({id, state});
    }
    return runs;
}

export function toLanePullRequest(node: any, repository: string): LanePullRequestRead {
    const commit = node.commits?.nodes?.[0]?.commit;
    const threads = (Array.isArray(node.reviewThreads?.nodes) ? node.reviewThreads.nodes : [])
        .filter((thread: any) => thread && typeof thread === 'object')
        .map((thread: any): ReviewThreadFacts => ({
            resolved: thread.isResolved === true,
            comments: typeof thread.comments?.totalCount === 'number' ? thread.comments.totalCount : 0,
            firstComment: typeof thread.comments?.nodes?.[0]?.body === 'string' ? thread.comments.nodes[0].body : '',
        }));
    return {
        id: text(node.id),
        repository,
        number: node.number,
        title: text(node.title),
        url: text(node.url) || `https://github.com/${repository}/pull/${node.number}`,
        author: typeof node.author?.login === 'string' && node.author.login ? node.author.login : null,
        state: node.state === 'MERGED' ? 'merged' : node.state === 'CLOSED' ? 'closed' : 'open',
        mergedAt: typeof node.mergedAt === 'string' && node.mergedAt ? node.mergedAt : null,
        draft: node.isDraft === true,
        headRef: text(node.headRefName),
        headOid: text(node.headRefOid),
        baseRef: text(node.baseRefName),
        ...(text(node.baseRefOid) ? {baseOid: text(node.baseRefOid)} : {}),
        labels: names(node.labels?.nodes, (label) => label?.name),
        automerge: toAutomergeStatus(commit?.status?.context),
        review: toReviewDecision(node.reviewDecision),
        approvedBy: names(
            (Array.isArray(node.latestReviews?.nodes) ? node.latestReviews.nodes : []).filter(
                (review: any) => review?.state === 'APPROVED',
            ),
            (review) => review?.author?.login,
        ),
        requestedReviewers: names(
            node.reviewRequests?.nodes,
            (request) => request?.requestedReviewer?.login ?? request?.requestedReviewer?.combinedSlug,
        ),
        unresolvedThreads: unresolvedThreadCount(threads),
        mergeState: typeof node.mergeStateStatus === 'string' ? node.mergeStateStatus.toLowerCase() : 'unknown',
        checks: (Array.isArray(commit?.statusCheckRollup?.contexts?.nodes)
            ? commit.statusCheckRollup.contexts.nodes
            : []
        )
            .map(toLaneCheck)
            .filter((check: LaneCheck | null): check is LaneCheck => check !== null),
        runs: toLaneRuns(commit?.checkSuites?.nodes),
    };
}

/** A check run as the queue reads it, or a commit status other than the queue's own; null for anything else. */
function toLaneCheck(node: any): LaneCheck | null {
    if (typeof node?.name === 'string' && node.name) return toQueueCheckRun(node);
    if (typeof node?.context !== 'string' || !node.context || node.context === AUTOMERGE_CONTEXT) return null;
    const created = typeof node.createdAt === 'string' ? Date.parse(node.createdAt) : NaN;
    const startedAt = Number.isFinite(created) ? created : null;
    switch (node.state) {
        case 'SUCCESS':
            return {name: node.context, state: 'passed', startedAt};
        case 'FAILURE':
        case 'ERROR':
            return {name: node.context, state: 'failed', startedAt};
        default:
            return {name: node.context, state: 'running', startedAt};
    }
}

/** The files in `.github/workflows`: empty when the directory is missing; null when the answer holds no repository. */
export function toWorkflowFiles(data: any): WorkflowFile[] | null {
    if (!data?.repository) return null;
    const entries = data.repository.object?.entries;
    if (!Array.isArray(entries)) return [];
    return entries
        .filter((entry: any) => typeof entry?.name === 'string' && typeof entry?.object?.text === 'string')
        .map((entry: any) => ({name: entry.name, text: entry.object.text}));
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function names(nodes: any, name: (node: any) => unknown): string[] {
    if (!Array.isArray(nodes)) return [];
    return nodes.map(name).filter((value): value is string => typeof value === 'string' && value !== '');
}
