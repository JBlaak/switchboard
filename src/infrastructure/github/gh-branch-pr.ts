/**
 * The PR of a branch (#414): the GraphQL `GhCli` sends to follow a Fix
 * session's branch through CI, the merge and its merge commit, and how the
 * answer maps. Kept apart from `gh-cli.ts`, like `gh-tags.ts`, so the
 * mapping can be tested from recorded responses.
 */
import {toCheck} from './gh-checks';
import type {BranchPullRequest} from '../../domain/inbox/stage';

/** The newest PR opened from `$branch`, its head commit's checks and, once merged, its merge commit. */
export const BRANCH_PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number
        url
        state
        isDraft
        mergedAt
        mergeCommit { oid }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * The branch's PR from `BRANCH_PULL_REQUEST_QUERY`'s data: `{pr: null}` when
 * the branch has none, null when the data holds no repository.
 */
export function toBranchPullRequest(data: any): {pr: BranchPullRequest | null} | null {
    const nodes = data?.repository?.pullRequests?.nodes;
    if (!Array.isArray(nodes)) return null;
    const node = nodes[0];
    if (!node || typeof node.number !== 'number') return {pr: null};
    const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const checks = (Array.isArray(contexts) ? contexts : []).filter(Boolean).map(toCheck);
    const counted = checks.filter((check) => check.state !== 'skipped');
    const failing = counted.filter((check) => check.state === 'failing').map((check) => check.name);
    const passed = counted.filter((check) => check.state === 'passing').length;
    const rollup: BranchPullRequest['checks']['state'] =
        counted.length === 0
            ? 'none'
            : failing.length > 0
              ? 'failing'
              : passed < counted.length
                ? 'pending'
                : 'passing';
    const state: BranchPullRequest['state'] =
        node.state === 'MERGED' ? 'merged' : node.state === 'CLOSED' ? 'closed' : node.isDraft ? 'draft' : 'open';
    return {
        pr: {
            number: node.number,
            url: typeof node.url === 'string' ? node.url : '',
            state,
            checks: {state: rollup, passed, total: counted.length, failing},
            mergedAt: typeof node.mergedAt === 'string' ? node.mergedAt : null,
            mergeCommit: typeof node.mergeCommit?.oid === 'string' ? node.mergeCommit.oid : null,
        },
    };
}
