/**
 * The project page's GraphQL (#167): the queries `GhCli` sends for a
 * repository's issues and pull requests, and how each answer maps onto the
 * overview domain.
 *
 * Kept apart from `gh-cli.ts`, like `gh-plans.ts`, so the mapping can be
 * tested from recorded responses on its own. The repository travels as
 * variables; the states written into a query's text are fixed. Responses are
 * read field by field with a fallback for each, so they are typed `any`.
 */
import type { IssueKey } from '../../domain/plan/model';
import type {
  CheckRollup, IssueLabel, RepositoryIssue, RepositoryPullRequest, ReviewDecision,
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
      const parent = node.parent && typeof node.parent.number === 'number'
        ? { repository: nameOf(node.parent, repository), number: node.parent.number }
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

/**
 * A repository's pull requests, open ones only unless merged ones are wanted.
 * Checks are counted by state rather than listed: the page shows one pill.
 */
export function pullRequestsInQuery(merged: boolean): string {
  return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: ${merged ? '[OPEN, MERGED]' : '[OPEN]'}, first: ${PULL_REQUESTS_PER_REPOSITORY}, orderBy: ${ORDER}) {
      nodes {
        number title state isDraft headRefName updatedAt reviewDecision
        repository { nameWithOwner }
        statusCheckRollup {
          state
          contexts(first: 1) {
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
          }
        }
        closingIssuesReferences(first: 20) { nodes { number repository { nameWithOwner } } }
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
          .map((issue: any): IssueKey => ({ repository: nameOf(issue, repository), number: issue.number })),
      };
    })
    .sort((a: RepositoryPullRequest, b: RepositoryPullRequest) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── Fields ──

/**
 * The check run and status states that someone has to act on, as `gh-cli.ts`
 * reads a single check: a failure, an error, and a run that was cancelled,
 * timed out, went stale or needs an action.
 */
const FAILING_CHECK_RUNS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const FAILING_STATUSES = new Set(['FAILURE', 'ERROR']);

/**
 * The rollup a PR's checks add up to. One failed check makes it `failing`,
 * even while others still run; otherwise GitHub's own rollup state decides.
 */
function toCheckRollup(rollup: any): CheckRollup {
  if (!rollup) return { state: 'none', failing: 0 };
  const failing = countOf(rollup.contexts?.checkRunCountsByState, FAILING_CHECK_RUNS)
    + countOf(rollup.contexts?.statusContextCountsByState, FAILING_STATUSES);
  if (failing > 0 || rollup.state === 'FAILURE' || rollup.state === 'ERROR') return { state: 'failing', failing };
  if (rollup.state === 'SUCCESS') return { state: 'passing', failing: 0 };
  return { state: 'running', failing: 0 };
}

function countOf(counts: any, states: ReadonlySet<string>): number {
  if (!Array.isArray(counts)) return 0;
  return counts.reduce((sum: number, entry: any) =>
    sum + (states.has(entry?.state) && typeof entry.count === 'number' ? entry.count : 0), 0);
}

function toReviewDecision(decision: unknown): ReviewDecision {
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (decision === 'REVIEW_REQUIRED') return 'review_required';
  return null;
}

function toLabel(label: any): IssueLabel {
  return { name: label.name, color: typeof label.color === 'string' ? label.color : '' };
}

function nameOf(node: any, fallback: string): string {
  const name = node?.repository?.nameWithOwner;
  return typeof name === 'string' && name ? name : fallback;
}
