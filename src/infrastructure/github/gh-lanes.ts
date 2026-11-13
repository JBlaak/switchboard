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

/** The lane read of these PRs in one repository. */
export function laneQuery(numbers: readonly number[]): string {
    const fields = numbers.map((number) => `pr${number}: pullRequest(number: ${number}) { ...laneFields }`);
    return `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef {
      name
      target { oid }
      rules(first: 50) {
        nodes {
          type
          parameters {
            ... on RequiredStatusChecksParameters { requiredStatusChecks { context } }
            ... on PullRequestParameters { dismissStaleReviewsOnPush requireLastPushApproval }
          }
        }
      }
    }
    ${fields.join('\n    ')}
  }
}

fragment laneFields on PullRequest {
  number title url state isDraft mergedAt headRefName headRefOid baseRefName reviewDecision mergeStateStatus
  author { login }
  labels(first: 20) { nodes { name } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { combinedSlug } } } }
  latestReviews(first: 20) { nodes { state author { login } } }
  reviewThreads(first: ${THREADS_PER_PULL_REQUEST}) { nodes { isResolved comments(first: 1) { totalCount nodes { body } } } }
  commits(last: 1) {
    nodes {
      commit {
        status { context(name: "${AUTOMERGE_CONTEXT}") { state description } }
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
        pullRequests,
    };
}

/** The rules of every active ruleset on the trunk, taken together. */
export function toTrunkRules(nodes: any): TrunkRules {
    const rules = Array.isArray(nodes) ? nodes : [];
    const required = new Set<string>();
    let approvalLostOnPush = false;
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
        }
    }
    return {requiredChecks: [...required], approvalLostOnPush};
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
